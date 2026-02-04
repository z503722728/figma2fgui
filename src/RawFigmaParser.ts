import { UINode, UIStyle } from './models/UINode';
import { ObjectType } from './models/FGUIEnum';

/**
 * RawFigmaParser: 直接解析 Figma REST API 返回的原始数据树
 */
export class RawFigmaParser {
    constructor() {}

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
        const localX = isRoot ? 0 : box.x - parentAbsX;
        const localY = isRoot ? 0 : box.y - parentAbsY;

        const uiNode: UINode = {
            id: node.id,
            name: node.name.replace(/\s+/g, '_'),
            type: this.mapType(node.type),
            x: Math.round(localX),
            y: Math.round(localY),
            width: Math.round(box.width),
            height: Math.round(box.height),
            styles: this.mapStyles(node),
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

    private mapType(type: string): ObjectType {
        switch (type) {
            case 'TEXT': return ObjectType.Text;
            case 'RECTANGLE': case 'ELLIPSE': case 'VECTOR': case 'REGULAR_POLYGON': case 'STAR': return ObjectType.Graph;
            case 'FRAME': case 'INSTANCE': case 'COMPONENT': return ObjectType.Component;
            case 'GROUP': return ObjectType.Container;
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
                styles.fillType = 'linear-gradient'; // 简化处理
            }
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
        }

        // 5. 文本样式
        if (node.type === 'TEXT' && node.style) {
            styles.fontSize = node.style.fontSize;
            styles.fontFamily = node.style.fontFamily;
            styles.fontWeight = node.style.fontWeight;
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
