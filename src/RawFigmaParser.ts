import { UINode } from './models/UINode';
import { ObjectType } from './models/FGUIEnum';
import { matchObjectType, getCoordZeroThreshold } from './rules/RuleLoader';

/**
 * RawFigmaParser: 直接解析 Figma REST API 返回的原始数据树。
 *
 * 改进（design2fgui）：
 * - mapType 优先读取 node.semanticType（由 AISemanticTagger 写入），
 *   降级到 rules/type-keywords.json 关键词匹配，最后才走原始类型推断。
 * - 坐标归零阈值从 rules/exclude-names.json 读取，不再写死 3.5。
 */
export class RawFigmaParser {
    private _coordZeroThreshold: number;

    constructor() {
        this._coordZeroThreshold = getCoordZeroThreshold();
    }

    public parse(figmaData: any): UINode[] {
        console.log("🛠️ 正在使用 RawFigmaParser 解析数据...");
        const rootNodes: UINode[] = [];

        if (figmaData.document) {
            figmaData.document.children.forEach((page: any) => {
                page.children.forEach((node: any) => {
                    if (node.type === 'FRAME' || node.type === 'INSTANCE' || node.type === 'COMPONENT') {
                        rootNodes.push(this.processNode(node, 0, 0, true));
                    }
                });
            });
        } else if (figmaData.nodes) {
            Object.values(figmaData.nodes).forEach((nodeData: any) => {
                if (!nodeData) return;
                const node = nodeData.document;
                if (node) {
                    const rootNode = this.processNode(node, 0, 0, true);
                    rootNode.asComponent = true;
                    rootNodes.push(rootNode);
                }
            });
        }

        return rootNodes;
    }

    private processNode(node: any, parentAbsX: number, parentAbsY: number, isRoot: boolean = false): UINode {
        const box = node.absoluteBoundingBox || { x: 0, y: 0, width: 0, height: 0 };

        let localX: number;
        let localY: number;
        let rotation = 0;

        // 优先使用 reparent 后计算的相对坐标（由 AISemanticTagger.reparentNodes 写入）
        if (node._reparentRelX !== undefined && node._reparentRelY !== undefined) {
            localX = node._reparentRelX;
            localY = node._reparentRelY;
        } else if (node.relativeTransform && !isRoot) {
            const a = node.relativeTransform[0][0];
            const c = node.relativeTransform[1][0];
            rotation = Math.round(Math.atan2(c, a) * (180 / Math.PI));
            localX = node.relativeTransform[0][2];
            localY = node.relativeTransform[1][2];
        } else {
            localX = isRoot ? 0 : box.x - parentAbsX;
            localY = isRoot ? 0 : box.y - parentAbsY;
        }

        // 坐标归零阈值从规则文件读取（不再写死 3.5）
        const threshold = this._coordZeroThreshold;
        if (Math.abs(localX) < threshold) localX = 0;
        if (Math.abs(localY) < threshold) localY = 0;

        const uiNode: UINode = {
            id: 'n' + (node.id ? node.id.replace(/[^a-zA-Z0-9]/g, '_') : Math.random().toString(36).substring(2, 5)),
            sourceId: node.id,
            name: node.name.replace(/\s+/g, '_'),
            // mapType 优先读取 AI 标注的 semanticType
            type: this.mapType(node),
            x: Math.round(localX),
            y: Math.round(localY),
            width: Math.round(box.width),
            height: Math.round(box.height),
            rotation,
            styles: this.mapStyles(node),
            customProps: {
                fillGeometry: node.fillGeometry,
                strokeGeometry: node.strokeGeometry,
                vectorPaths: node.vectorPaths,
                isMask: node.isMask,
                maskType: node.maskType,
                layoutPositioning: node.layoutPositioning,
                constraints: node.constraints,
            },
            children: [],
            text: node.characters,
            visible: node.visible !== false && !node.isMask && node.opacity !== 0,
            // 传递 AI 标注字段（如果 figmaData 已被 AISemanticTagger.applyTags 处理）
            semanticType: node.semanticType,
            childrenRoles: node.childrenRoles,
            statePages: node.statePages,
            semanticRisks: node.semanticRisks,
            // buttonMode：AI 标注的 Button 工作模式（Check=Toggle/复选，Radio=单选）
            buttonMode: node.buttonMode,
            // 合并渲染标记
            _mergedInto: node._mergedInto,
            // 本地多图合并配置
            _mergeLayers: node._mergeLayers,
            // List item template 名称（AI 标注）
            _listItemTemplateName: node._listItemTemplateName,
            // List item template 节点 ID（AI 标注，精确定位）
            _listItemNodeId: node._listItemNodeId,
            // List 布局参数（AI 标注）
            _listColGap: node._listColGap,
            _listRowGap: node._listRowGap,
            _listNumItems: node._listNumItems,
            // 多变体图层（AI 标注）
            _variantLayers: node._variantLayers,
            // reparent 记录（调试用）
            _reparentedTo: node._reparentedTo,
        };

        if (uiNode.type === ObjectType.ProgressBar || uiNode.type === ObjectType.Slider) {
            uiNode.value = 50;
            uiNode.max = 100;
            uiNode.min = 0;
        }

        // 非根容器有复杂填充（渐变/图片）→ 插入虚拟背景节点触发 SSR
        const hasComplexFills =
            (node.fills && node.fills.some((f: any) => f.visible !== false && f.type !== 'SOLID')) ||
            (node.background && node.background.some((f: any) => f.visible !== false && f.type !== 'SOLID'));

        if ((uiNode.type === ObjectType.Component || uiNode.type === ObjectType.Group) && hasComplexFills && !isRoot) {
            const bgNode: UINode = {
                id: uiNode.id + '_bg',
                sourceId: node.id,
                name: uiNode.name + '_bg',
                type: ObjectType.Image,
                x: 0,
                y: 0,
                width: uiNode.width,
                height: uiNode.height,
                customProps: {
                    fillGeometry: [{ path: `M0 0L${uiNode.width} 0L${uiNode.width} ${uiNode.height}L0 ${uiNode.height}L0 0Z`, windingRule: 'NONZERO' }],
                    isMask: false
                },
                styles: { ...uiNode.styles, fillType: 'solid' },
                children: []
            };
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

    /**
     * Figma 节点类型 → FGUI ObjectType。
     *
     * 优先级：
     * 1. node.semanticType（AISemanticTagger 写入）
     * 2. rules/type-keywords.json 关键词匹配（设计师命名语义）
     * 3. Figma 原始类型推断（固定规则）
     */
    private mapType(node: any): ObjectType {
        const type = node.type;
        const name = (node.name || "").toLowerCase();

        // 1. AI 语义标注优先
        if (node.semanticType) {
            const semanticMap: Record<string, ObjectType> = {
                'Button': ObjectType.Button,
                'ProgressBar': ObjectType.ProgressBar,
                'Slider': ObjectType.Slider,
                'ComboBox': ObjectType.ComboBox,
                'List': ObjectType.List,
                'Label': ObjectType.Label,
                'Text': ObjectType.Text,
                'Image': ObjectType.Image,
                'Graph': ObjectType.Graph,
                'Group': ObjectType.Group,
                'Component': ObjectType.Component,
            };
            const mapped = semanticMap[node.semanticType];
            if (mapped !== undefined) {
                console.log(`🤖 AI标注: "${node.name}" → ${node.semanticType}`);
                return mapped;
            }
        }

        // 2. 固定类型（TEXT / 矢量图形）
        if (type === 'TEXT') return ObjectType.Text;

        if (type === 'VECTOR' || type === 'STAR' || type === 'REGULAR_POLYGON' ||
            type === 'BOOLEAN_OPERATION' || type === 'RECTANGLE' || type === 'ELLIPSE') {
            return ObjectType.Image;
        }

        // 3. 容器类型 → 优先 rules/type-keywords.json 关键词匹配
        const isContainer = (type === 'FRAME' || type === 'INSTANCE' || type === 'COMPONENT' || type === 'GROUP');
        if (isContainer) {
            const matchedTypeName = matchObjectType(name);
            if (matchedTypeName) {
                const containerTypeMap: Record<string, ObjectType> = {
                    'Button': ObjectType.Button,
                    'ProgressBar': ObjectType.ProgressBar,
                    'Slider': ObjectType.Slider,
                    'ComboBox': ObjectType.ComboBox,
                    'List': ObjectType.List,
                    'Label': ObjectType.Label,
                    'ScrollPane': ObjectType.ScrollBar,
                };
                const objType = containerTypeMap[matchedTypeName];
                if (objType !== undefined) return objType;
            }

            if (type === 'GROUP') return ObjectType.Group;
            return ObjectType.Component;
        }

        return ObjectType.Graph;
    }

    private mapStyles(node: any): any {
        const styles: any = {};

        // 节点自身整体透明度（Figma opacity 属性）
        if (node.opacity !== undefined && node.opacity !== 1 && node.opacity > 0) {
            styles.opacity = node.opacity.toFixed(2);
        }

        if (node.fills && Array.isArray(node.fills)) {
            const visibleFills = node.fills.filter((f: any) => f.visible !== false);

            const solidFill = visibleFills.find((f: any) => f.type === 'SOLID');
            if (solidFill) {
                styles.fillType = 'solid';
                // 把 fill-level opacity 合并进颜色的 alpha 通道（FGUI #AARRGGBB）
                const fillOpacity = solidFill.opacity ?? 1;
                styles.fillColor = this.figmaColorToHex(solidFill.color, fillOpacity);
                styles.fillOpacity = fillOpacity;
            }

            const gradientFill = visibleFills.find((f: any) => f.type.includes('GRADIENT'));
            if (gradientFill) {
                styles.gradient = {
                    type: gradientFill.type,
                    handles: gradientFill.gradientHandlePositions,
                    stops: gradientFill.gradientStops.map((s: any) => ({
                        color: this.figmaColorToHex(s.color),
                        opacity: s.color.a ?? 1,
                        offset: s.position
                    }))
                };
                if (!styles.fillColor && gradientFill.gradientStops.length > 0) {
                    styles.fillColor = this.figmaColorToHex(gradientFill.gradientStops[0].color);
                    styles.fillOpacity = gradientFill.gradientStops[0].color.a ?? 1;
                }
            }

            const imageFill = visibleFills.find((f: any) => f.type === 'IMAGE');
            if (imageFill) {
                styles.imageFill = {
                    imageHash: imageFill.imageHash,
                    scaleMode: imageFill.scaleMode
                };
            }
        }

        if (node.type === 'VECTOR' || node.type === 'STAR' || node.type === 'REGULAR_POLYGON' ||
            node.type === 'BOOLEAN_OPERATION' || node.type === 'RECTANGLE' || node.type === 'ELLIPSE') {
            styles.fillType = 'image';
        }

        if (node.strokes && node.strokes.length > 0) {
            const strokeOpacity = node.strokes[0].opacity ?? 1;
            styles.strokeSize = node.strokeWeight || 1;
            styles.strokeColor = this.figmaColorToHex(node.strokes[0].color, strokeOpacity);
            styles.strokeOpacity = strokeOpacity;
        }

        if (node.effects && Array.isArray(node.effects)) {
            const visibleEffects = node.effects.filter((e: any) => e.visible !== false);
            if (visibleEffects.length > 0) {
                styles.filters = visibleEffects.map((e: any) => ({
                    type: e.type,
                    color: e.color ? this.figmaColorToHex(e.color) : null,
                    opacity: e.color ? (e.color.a ?? 1) : 1,
                    offset: e.offset,
                    radius: e.radius,
                    spread: e.spread
                }));
            }
        }

        if (node.cornerRadius) styles.cornerRadius = node.cornerRadius.toString();
        if (node.itemSpacing) styles.gap = node.itemSpacing.toString();

        if (node.layoutMode) {
            styles.display = 'flex';
            styles.flexDirection = node.layoutMode === 'HORIZONTAL' ? 'row' : 'column';
            if (node.primaryAxisAlignItems) styles.justifyContent = this.mapAlign(node.primaryAxisAlignItems);
            if (node.counterAxisAlignItems) styles.alignItems = this.mapAlign(node.counterAxisAlignItems);
            if (node.paddingTop) styles.paddingTop = node.paddingTop;
            if (node.paddingBottom) styles.paddingBottom = node.paddingBottom;
            if (node.paddingLeft) styles.paddingLeft = node.paddingLeft;
            if (node.paddingRight) styles.paddingRight = node.paddingRight;
        }

        if (node.type === 'TEXT' && node.style) {
            styles.fontSize = node.style.fontSize;
            styles.fontFamily = node.style.fontFamily;
            styles.fontWeight = node.style.fontWeight;
            if (node.fills && node.fills.length > 0 && node.fills[0].type === 'SOLID') {
                styles.color = this.figmaColorToHex(node.fills[0].color, node.fills[0].opacity);
            }
            if (node.style.textAlignHorizontal) styles.textAlign = node.style.textAlignHorizontal;
            if (node.style.textAlignVertical) styles.verticalAlign = node.style.textAlignVertical;
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
        // color.a 是 Figma 颜色自身的 alpha（stop alpha 等），opacity 是 fill 级别的不透明度
        // FGUI 颜色格式：#AARRGGBB（Alpha 在最前）
        const alpha = color.a !== undefined ? color.a : 1;
        const finalAlpha = alpha * opacity;
        if (finalAlpha < 1) {
            const a = Math.round(finalAlpha * 255).toString(16).padStart(2, '0');
            return `#${a}${r}${g}${b}`.toUpperCase();
        }
        return `#${r}${g}${b}`.toUpperCase();
    }
}
