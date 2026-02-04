import { UINode } from './models/UINode';
import { ObjectType } from './models/FGUIEnum';

/**
 * RawFigmaParser: 直接解析 Figma REST API 返回的原始数据树
 */
export class RawFigmaParser {
    constructor() { }

    public parse(figmaData: any): UINode[] {
        console.log("🛠️ 正在使用 RawFigmaParser 解析数据...");
        const rootNodes: UINode[] = [];
        
        // 情况 1: 原始全量文件数据 (GET /v1/files/:key)
        if (figmaData.document) {
            figmaData.document.children.forEach((page: any) => {
                page.children.forEach((node: any) => {
                    if (node.type === 'FRAME' || node.type === 'INSTANCE' || node.type === 'COMPONENT') {
                        rootNodes.push(this.processNode(node, 0, 0, true));
                    }
                });
            });
        } 
        // 情况 2: 特定节点数据 (GET /v1/files/:key/nodes)
        else if (figmaData.nodes) {
            Object.values(figmaData.nodes).forEach((nodeData: any) => {
                const node = nodeData.document;
                if (node) {
                    const rootNode = this.processNode(node, 0, 0, true);
                    rootNode.asComponent = true; // 💡 顶级节点强制作为组件，防止被 Merger 误伤
                    rootNodes.push(rootNode);
                }
            });
        }

        return rootNodes;
    }

    private processNode(node: any, parentAbsX: number, parentAbsY: number, isRoot: boolean = false): UINode {
        const box = node.absoluteBoundingBox || { x: 0, y: 0, width: 0, height: 0 };
        
        // 坐标转换：优先使用 relativeTransform (更精准的本地坐标)，降级使用 absoluteBoundingBox
        let localX: number;
        let localY: number;
        let rotation = 0;

        if (node.relativeTransform && !isRoot) {
            // relativeTransform is [[a, b, tx], [c, d, ty]]
            // a=cos(theta), b=-sin(theta), c=sin(theta), d=cos(theta)
            const a = node.relativeTransform[0][0];
            const c = node.relativeTransform[1][0];
            rotation = Math.round(Math.atan2(c, a) * (180 / Math.PI));

            localX = node.relativeTransform[0][2];
            localY = node.relativeTransform[1][2];
        } else {
            localX = isRoot ? 0 : box.x - parentAbsX;
            localY = isRoot ? 0 : box.y - parentAbsY;
        }

        // 💡 针对旋转节点的坐标修正：Figma 的 tx/ty 是旋转后的左上角，FGUI 需要中心点或未旋转前的坐标？
        // 实际上 FGUI 的 xy 配合 rotation 表现与 Figma 的 relativeTransform tx/ty 较一致（左上角旋转）

        // 💡 Pragmatic Fix: Snap small offsets to 0 to fix "0,-2" type issues logic
        if (Math.abs(localX) < 3.5) localX = 0;
        if (Math.abs(localY) < 3.5) localY = 0;

        const uiNode: UINode = {
            id: 'n' + (node.id ? node.id.replace(/[^a-zA-Z0-9]/g, '_') : Math.random().toString(36).substring(2, 5)), 
            sourceId: node.id, 
            name: node.name.replace(/\s+/g, '_'),
            type: this.mapType(node),
            x: Math.round(localX),
            y: Math.round(localY),
            width: Math.round(box.width),
            height: Math.round(box.height),
            rotation: rotation,
            renderBounds: node.absoluteRenderBounds ? {
                x: node.absoluteRenderBounds.x - box.x,
                y: node.absoluteRenderBounds.y - box.y,
                width: node.absoluteRenderBounds.width,
                height: node.absoluteRenderBounds.height
            } : undefined,
            styles: this.mapStyles(node),
            customProps: {
                fillGeometry: node.fillGeometry,
                strokeGeometry: node.strokeGeometry,
                vectorPaths: node.vectorPaths,
                isMask: node.isMask,
                maskType: node.maskType
            },
            children: [],
            text: node.characters
        };

        // 💡 进阶逻辑：针对 Frame/Component 本身的背景填充，如果不是单色，则插入一个虚拟的背景节点
        const fillType = uiNode.styles.fillType;
        const hasComplexFills = (node.fills && node.fills.some((f: any) => f.visible !== false && f.type !== 'SOLID')) || 
            (node.background && node.background.some((f: any) => f.visible !== false && f.type !== 'SOLID'));

        if ((uiNode.type === ObjectType.Component || uiNode.type === ObjectType.Group) && hasComplexFills) {
            const bgNode: UINode = {
                id: uiNode.id + '_bg',
                name: uiNode.name + '_bg',
                type: ObjectType.Image, // 强制作为图像导出为 SVG
                x: 0,
                y: 0,
                width: uiNode.width,
                height: uiNode.height,
                customProps: {
                    fillGeometry: [{ path: `M0 0L${uiNode.width} 0L${uiNode.width} ${uiNode.height}L0 ${uiNode.height}L0 0Z`, windingRule: 'NONZERO' }],
                    isMask: false
                },
                styles: { ...uiNode.styles, fillType: 'solid' }, // 保持原有样式，但标记为 solid 触发渲染映射
                children: []
            };
            // 修正父节点样式，防止底层 FGUI 渲染出一个多余的颜色
            uiNode.styles.fillColor = 'transparent';
            uiNode.children!.push(bgNode);
        }

        if (node.children) {
            node.children.forEach((child: any) => {
                uiNode.children!.push(this.processNode(child, box.x, box.y));
            });
        }

        return uiNode;
    }

    private mapType(node: any): ObjectType {
        const type = node.type;
        // 💡 进阶逻辑：将所有具有矢量潜力的节点映射为 Image，以便生成 SVG 保证还原度
        if (type === 'VECTOR' || type === 'STAR' || type === 'REGULAR_POLYGON' || type === 'BOOLEAN_OPERATION' ||
            type === 'RECTANGLE' || type === 'ELLIPSE') {
            return ObjectType.Image;
        }
        switch (type) {
            case 'TEXT': return ObjectType.Text;
            case 'FRAME': case 'INSTANCE': case 'COMPONENT': return ObjectType.Component;
            case 'GROUP': return ObjectType.Group;
            default: return ObjectType.Graph;
        }
    }

    private mapStyles(node: any): any {
        const styles: any = {};

        // 1. 处理填充 (Fills)
        if (node.fills && Array.isArray(node.fills)) {
            const visibleFills = node.fills.filter((f: any) => f.visible !== false);
            
            // 实色填充
            const solidFill = visibleFills.find((f: any) => f.type === 'SOLID');
            if (solidFill) {
                styles.fillType = 'solid';
                styles.fillColor = this.figmaColorToHex(solidFill.color);
                styles.fillOpacity = solidFill.opacity ?? 1;
            }

            // 渐变填充
            const gradientFill = visibleFills.find((f: any) => f.type.includes('GRADIENT'));
            if (gradientFill) {
                styles.gradient = {
                    type: gradientFill.type, // GRADIENT_LINEAR or GRADIENT_RADIAL
                    handles: gradientFill.gradientHandlePositions,
                    stops: gradientFill.gradientStops.map((s: any) => ({
                        color: this.figmaColorToHex(s.color),
                        opacity: s.color.a ?? 1,
                        offset: s.position
                    }))
                };
                // 降级颜色
                if (!styles.fillColor && gradientFill.gradientStops.length > 0) {
                    styles.fillColor = this.figmaColorToHex(gradientFill.gradientStops[0].color);
                    styles.fillOpacity = gradientFill.gradientStops[0].color.a ?? 1;
                }
            }

            // 图片填充
            const imageFill = visibleFills.find((f: any) => f.type === 'IMAGE');
            if (imageFill) {
                styles.imageFill = {
                    imageHash: imageFill.imageHash,
                    scaleMode: imageFill.scaleMode
                };
            }
        }

        // 💡 矢量节点强制设为 image 填充类型，触发后续的 REST API 渲染下载 (作为回退或元数据)
        if (node.type === 'VECTOR' || node.type === 'STAR' || node.type === 'REGULAR_POLYGON' || node.type === 'BOOLEAN_OPERATION' ||
            node.type === 'RECTANGLE' || node.type === 'ELLIPSE') {
            styles.fillType = 'image';
        }

        // 2. 处理边框
        if (node.strokes && node.strokes.length > 0) {
            styles.strokeSize = node.strokeWeight || 1;
            styles.strokeColor = this.figmaColorToHex(node.strokes[0].color);
            styles.strokeOpacity = node.strokes[0].opacity ?? 1;
        }

        // 2.1 处理滤镜 (Effects: Shadows, Blurs)
        if (node.effects && Array.isArray(node.effects)) {
            const visibleEffects = node.effects.filter((e: any) => e.visible !== false);
            if (visibleEffects.length > 0) {
                styles.filters = visibleEffects.map((e: any) => ({
                    type: e.type, // DROP_SHADOW, INNER_SHADOW, LAYER_BLUR, BACKGROUND_BLUR
                    color: e.color ? this.figmaColorToHex(e.color) : null,
                    opacity: e.color ? (e.color.a ?? 1) : 1,
                    offset: e.offset,
                    radius: e.radius,
                    spread: e.spread
                }));
            }
        }

        // 3. 处理圆角
        if (node.cornerRadius) styles.cornerRadius = node.cornerRadius.toString();
        if (node.itemSpacing) styles.gap = node.itemSpacing.toString();

        // 4. 处理 Flex 布局 (Figma Auto Layout)
        if (node.layoutMode) {
            styles.display = 'flex';
            styles.flexDirection = node.layoutMode === 'HORIZONTAL' ? 'row' : 'column';
            if (node.primaryAxisAlignItems) {
                styles.justifyContent = this.mapAlign(node.primaryAxisAlignItems);
            }
            if (node.counterAxisAlignItems) {
                styles.alignItems = this.mapAlign(node.counterAxisAlignItems);
            }
            if (node.paddingTop) styles.paddingTop = node.paddingTop;
            if (node.paddingBottom) styles.paddingBottom = node.paddingBottom;
            if (node.paddingLeft) styles.paddingLeft = node.paddingLeft;
            if (node.paddingRight) styles.paddingRight = node.paddingRight;
        }

        // 5. 文本样式
        if (node.type === 'TEXT' && node.style) {
            styles.fontSize = node.style.fontSize;
            styles.fontFamily = node.style.fontFamily;
            styles.fontWeight = node.style.fontWeight;
            
            // 💡 Fix: Map text color from fills explicitly for Text nodes
            // PropertyMapper expects styles.color, but we only mapped fillType/fillColor above
            if (node.fills && node.fills.length > 0 && node.fills[0].type === 'SOLID') {
                styles.color = this.figmaColorToHex(node.fills[0].color, node.fills[0].opacity);
            }

            // 💡 Alignment Mappings
            if (node.style.textAlignHorizontal) {
                styles.textAlign = node.style.textAlignHorizontal;
            }
            if (node.style.textAlignVertical) {
                styles.verticalAlign = node.style.textAlignVertical;
            }
        }

        return styles;
    }

    private mapAlign(figmaAlign: string): string {
        switch (figmaAlign) {
            case 'CENTER': return 'center';
            case 'MAX': return 'flex-end';
            case 'SPACE_BETWEEN': return 'space-between';
            default: return 'flex-start';
        }
    }

    private figmaColorToHex(color: any, opacity: number = 1): string {
        if (!color) return '#000000';
        const r = Math.round(color.r * 255).toString(16).padStart(2, '0');
        const g = Math.round(color.g * 255).toString(16).padStart(2, '0');
        const b = Math.round(color.b * 255).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`.toUpperCase();
    }
}
