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
                    rootNodes.push(this.processNode(node, 0, 0, true));
                }
            });
        }

        return rootNodes;
    }

    private processNode(node: any, parentAbsX: number, parentAbsY: number, isRoot: boolean = false): UINode {
        const box = node.absoluteBoundingBox || { x: 0, y: 0, width: 0, height: 0 };
        
        // 坐标转换：FGUI 需要相对父级的坐标
        // 💡 修正坐标计算：确保即使是 Root 也能保留相对位置（如果不是 0,0）
        const localX = isRoot ? 0 : box.x - parentAbsX;
        const localY = isRoot ? 0 : box.y - parentAbsY;

        const uiNode: UINode = {
            id: 'n' + (node.id ? node.id.replace(/[^a-zA-Z0-9]/g, '_') : Math.random().toString(36).substring(2, 5)), 
            sourceId: node.id, 
            name: node.name.replace(/\s+/g, '_'),
            type: this.mapType(node),
            x: Math.round(localX),
            y: Math.round(localY),
            width: Math.round(box.width),
            height: Math.round(box.height),
            styles: this.mapStyles(node),
            customProps: {
                fillGeometry: node.fillGeometry,
                strokeGeometry: node.strokeGeometry,
                vectorPaths: node.vectorPaths
            },
            children: [],
            text: node.characters
        };

        if (node.children) {
            node.children.forEach((child: any) => {
                uiNode.children!.push(this.processNode(child, box.x, box.y));
            });
        }

        return uiNode;
    }

    private mapType(node: any): ObjectType {
        const type = node.type;
        // 💡 进阶逻辑：如果 VECTOR/STAR 等节点包含复杂矢量数据，且不是简单的图形，则标记为 Image
        if (type === 'VECTOR' || type === 'STAR' || type === 'REGULAR_POLYGON' || type === 'BOOLEAN_OPERATION') {
            return ObjectType.Image;
        }
        switch (type) {
            case 'TEXT': return ObjectType.Text;
            case 'RECTANGLE': return ObjectType.Graph;
            case 'ELLIPSE': return ObjectType.Graph;
            case 'FRAME': case 'INSTANCE': case 'COMPONENT': return ObjectType.Component;
            case 'GROUP': return ObjectType.Group;
            default: return ObjectType.Graph;
        }
    }

    private mapStyles(node: any): any {
        const styles: any = {};

        // 1. 处理填充 (Fills)
        if (node.fills && node.fills.length > 0) {
            const fill = node.fills[0];
            if (fill.type === 'SOLID') {
                styles.fillType = 'solid';
                styles.fillColor = this.figmaColorToHex(fill.color, fill.opacity);
            } else if (fill.type === 'IMAGE') {
                styles.fillType = 'image';
            } else if (fill.type.includes('GRADIENT')) {
                styles.fillType = 'image'; // 渐变也强制导出为图片，保证 FGUI 渲染一致性
            }
        }

        // 💡 矢量节点强制设为 image 填充类型，触发后续的 REST API 渲染下载
        if (node.type === 'VECTOR' || node.type === 'STAR' || node.type === 'REGULAR_POLYGON' || node.type === 'BOOLEAN_OPERATION') {
            styles.fillType = 'image';
        }

        // 2. 处理边框
        if (node.strokes && node.strokes.length > 0) {
            styles.strokeSize = node.strokeWeight || 1;
            styles.strokeColor = this.figmaColorToHex(node.strokes[0].color);
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
