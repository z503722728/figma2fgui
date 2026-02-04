import { UINode, ResourceInfo } from './models/UINode';
import { ObjectType } from './models/FGUIEnum';

/**
 * Figma2FGUI Parser - 处理节点提取与坐标转换
 */
export class FigmaParser {
    constructor(private config: any = {}) { }

    public parse(figmaData: any[]): UINode[] {
        console.log("🚀 开始解析 Figma JSON (深度坐标转换模式)...");
        const components: UINode[] = [];

        figmaData.forEach(rootNode => {
            if (rootNode.type === 'FRAME' || rootNode.type === 'INSTANCE') {
                components.push(this.processElement(rootNode, 0, 0, true));
            }
        });

        return components;
    }

    private processElement(node: any, parentAbsX: number, parentAbsY: number, isComponentRoot: boolean = false, siblingIndex: number = 0): UINode {
        // 尝试从 cssProps 获取坐标，如果没有则根据索引简单堆叠（仅作为演示用的兜底逻辑）
        let localX = parseFloat(node.cssProps.left);
        let localY = parseFloat(node.cssProps.top);
        
        const hasDefinedPos = !isNaN(localX) && !isNaN(localY);
        
        if (!hasDefinedPos) {
            localX = 0;
            localY = 0;
            // 💡 启发式：如果父级看起来像个列表，我们简单做个垂直偏移
            if (siblingIndex > 0) {
                // 暂时不启用自动堆叠，因为可能会搞乱原本重合的图层（如背景）
            }
        }

        const absX = parentAbsX + (localX || 0);
        const absY = parentAbsY + (localY || 0);

        const relativeX = isComponentRoot ? 0 : (localX || 0);
        const relativeY = isComponentRoot ? 0 : (localY || 0);

        const w = Math.round(parseFloat(node.cssProps.width) || 0);
        const h = Math.round(parseFloat(node.cssProps.height) || 0);

        const nodeType = this.mapToObjectType(node.type);

        const element: UINode = {
            id: 'n' + (node.id ? node.id.replace(/[^a-zA-Z0-9]/g, '_') : Math.random().toString(36).substring(2, 5)), 
            sourceId: node.id, 
            type: nodeType,
            name: node.name.replace(/\s+/g, '_'),
            x: relativeX,
            y: relativeY,
            width: w,
            height: h,
            styles: this.processStyles(node.cssProps),
            customProps: {},
            children: []
        };

        // 处理旋转
        if (node.cssProps.transform && node.cssProps.transform.includes('rotate')) {
            const rotateMatch = node.cssProps.transform.match(/rotate\(([\d.-]+)deg\)/);
            if (rotateMatch) {
                element.rotation = parseFloat(rotateMatch[1]);
            }
        }

        // 处理文本特有属性
        if (node.type === 'TEXT') {
            element.text = node.characters || "";
            Object.assign(element.styles, this.processTextStyles(node.cssProps));
        }

        // 递归处理子节点
        if (node.children) {
            node.children.forEach((child: any, index: number) => {
                const subEl = this.processElement(child, absX, absY, false, index);
                if (subEl) element.children!.push(subEl);
            });
        }

        return element;
    }

    private mapToObjectType(figmaType: string): ObjectType {
        switch (figmaType) {
            case 'TEXT': return ObjectType.Text;
            case 'RECTANGLE': return ObjectType.Graph; // FGUI 里一般矩形用 Graph
            case 'ELLIPSE': return ObjectType.Graph;
            case 'STAR': return ObjectType.Graph;
            case 'INSTANCE': return ObjectType.Component;
            case 'FRAME': return ObjectType.Component;
            case 'GROUP': return ObjectType.Group;
            default: return ObjectType.Graph;
        }
    }

    private processStyles(css: any): Record<string, any> {
        const styles: Record<string, any> = { ...css }; // 💡 关键：保留原始 cssProps 供 Flex 计算使用

        // 1. 填充 (Fills)
        if (css.background) {
            if (css.background.includes('linear-gradient')) {
                styles.fillType = 'linear-gradient';
                styles.gradient = this.parseGradient(css.background);
            } else if (css.background.includes('url(')) {
                styles.fillType = 'image';
                const urlMatch = css.background.match(/url\((.*?)\)/);
                styles.src = urlMatch ? urlMatch[1] : undefined;
            } else {
                styles.fillType = 'solid';
                styles.fillColor = this.convertColor(css.background);
            }
        } else if (css.fill) {
            styles.fillType = 'solid';
            styles.fillColor = this.convertColor(css.fill);
        }

        // 2. 边框 (Stroke)
        if (css.border) {
            const borderMatch = css.border.match(/(\d+)px\s+solid\s+(.*)/);
            if (borderMatch) {
                styles.strokeSize = parseInt(borderMatch[1]);
                styles.strokeColor = this.convertColor(borderMatch[2]);
            }
        } else if (css['stroke-width']) {
            styles.strokeSize = parseInt(css['stroke-width']);
            styles.strokeColor = this.convertColor(css.stroke || '#000000');
        }

        // 3. 圆角 (Corner Radius)
        if (css['border-radius']) {
            styles.cornerRadius = css['border-radius'].split(' ').map((v: string) => parseInt(v) || 0).join(',');
        }

        // 4. 阴影 (Effects)
        if (css['box-shadow'] || css.filter?.includes('drop-shadow')) {
            const shadowStr = css['box-shadow'] || css.filter;
            styles.shadow = this.parseShadow(shadowStr);
        }

        // 5. 不透明度
        if (css.opacity) {
            styles.opacity = parseFloat(css.opacity);
        }

        return styles;
    }

    private processTextStyles(css: any): any {
        return {
            fontSize: parseInt(css['font-size']) || 12,
            color: this.convertColor(css.color || "#000000"),
            align: css['text-align'] || 'left',
            fontFamily: css['font-family'],
            fontWeight: css['font-weight'],
            letterSpacing: parseInt(css['letter-spacing']) || 0,
            italic: css['font-style'] === 'italic',
            underline: css['text-decoration']?.includes('underline'),
            strokeSize: parseInt(css['-webkit-text-stroke-width']) || 0,
            strokeColor: this.convertColor(css['-webkit-text-stroke-color'] || '#000000'),
            textShadow: css['text-shadow'] ? this.parseShadow(css['text-shadow']) : null
        };
    }

    private parseGradient(str: string): any {
        const stops: any[] = [];
        const colorStopMatch = str.matchAll(/(#[a-fA-F0-9]{3,6}|rgba?\(.*?\))\s+([\d.]+)%/g);
        for (const match of colorStopMatch) {
            stops.push({
                color: this.convertColor(match[1]),
                offset: parseFloat(match[2]) / 100
            });
        }
        const angleMatch = str.match(/(\d+)deg/);
        return {
            angle: angleMatch ? parseInt(angleMatch[1]) : 0,
            stops: stops
        };
    }

    private parseShadow(str: string): any {
        const shadowMatch = str.match(/([\d.-]+)px\s+([\d.-]+)px\s+([\d.-]+)px\s+([\d.-]+)?p?x?\s*(rgba?\(.*?\)|#[a-fA-F0-9]{3,6})/);
        if (shadowMatch) {
            return {
                offsetX: parseFloat(shadowMatch[1]),
                offsetY: parseFloat(shadowMatch[2]),
                blur: parseFloat(shadowMatch[3]),
                spread: parseFloat(shadowMatch[4]) || 0,
                color: this.convertColor(shadowMatch[5])
            };
        }
        return null;
    }

    private convertColor(color: string): string {
        if (!color) return "#000000";
        if (color.startsWith('rgba')) {
            const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (match) {
                const r = parseInt(match[1]).toString(16).padStart(2, '0');
                const g = parseInt(match[2]).toString(16).padStart(2, '0');
                const b = parseInt(match[3]).toString(16).padStart(2, '0');
                return `#${r}${g}${b}`.toUpperCase();
            }
        }
        // 处理 #FFF 缩写
        if (color.startsWith('#') && color.length === 4) {
            const r = color[1];
            const g = color[2];
            const b = color[3];
            return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
        }
        return color.toUpperCase();
    }
}
