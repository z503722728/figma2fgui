import { ObjectType, LoaderFillType, AlignType, VertAlignType } from "../models/FGUIEnum";
import { UINode } from "../models/UINode";
import { getVisualPadding, FGUI_SCALE } from "../Common";
import { Rules } from "../rules/RuleLoader";

/**
 * PropertyMapper: 将 UINode 样式属性映射为 FGUI XML 属性。
 *
 * 改进（design2fgui）：
 * - Loader defaultFillMode 从 rules/pipeline-config.json 读取，不再写死 scaleFree。
 */
export class PropertyMapper {
    private _defaultFillMode: number;

    constructor() {
        try {
            const modeName = Rules.pipeline().loader.defaultFillMode;
            this._defaultFillMode = (LoaderFillType as any)[modeName] ?? LoaderFillType.scaleFree;
        } catch {
            this._defaultFillMode = LoaderFillType.scaleFree;
        }
    }

    public mapAttributes(node: UINode, assignedId?: string): Record<string, string> {
        const s = node.styles;
        const isIconLoader = node.name === 'icon' && node.type === ObjectType.Loader && node.src;
        const padding = (node.src && !isIconLoader) ? getVisualPadding(node) : 0;

        const x = (node.x - padding) * FGUI_SCALE;
        const y = (node.y - padding) * FGUI_SCALE;
        const w = (parseFloat(s.width || node.width.toString()) + padding * 2) * FGUI_SCALE;
        const h = (parseFloat(s.height || node.height.toString()) + padding * 2) * FGUI_SCALE;

        const attr: Record<string, string> = {
            id: assignedId || node.id || 'n' + Math.random().toString(36).substring(2, 5),
            name: (assignedId && node.name !== 'title' && node.name !== 'icon') ? assignedId : (node.name || 'n0'),
            xy: `${Math.round(x)},${Math.round(y)}`,
            size: `${Math.round(w)},${Math.round(h)}`
        };

        if (s.opacity) attr.alpha = s.opacity;
        if (node.rotation) attr.rotation = node.rotation.toString();

        switch (node.type) {
            case ObjectType.Text:
            case ObjectType.InputText:
                this.mapTextProperties(node, attr);
                break;
            case ObjectType.Image:
            case ObjectType.Loader:
                this.mapLoaderProperties(node, attr);
                break;
        }

        if (node.type === ObjectType.Graph || node.type === ObjectType.Component || node.type === ObjectType.Group) {
            this.mapGraphProperties(node, attr);
        }

        return attr;
    }

    private mapTextProperties(node: UINode, attr: Record<string, string>): void {
        const s = node.styles;
        const rawFontSize = parseFloat((s['font-size'] || s.fontSize || "12").toString());
        attr.fontSize = Math.round(rawFontSize * FGUI_SCALE).toString();
        attr.color = this.formatColor(s.color || "#000000");

        if (s['text-align'] || s.align || s.textAlign) {
            const alignVal = (s['text-align'] || s.align || s.textAlign).toLowerCase();
            if (alignVal === 'center' || alignVal === 'right') attr.align = alignVal as AlignType;
            else if (alignVal === 'justify') attr.align = AlignType.left;
            else attr.align = AlignType.left;
        }

        if (s.verticalAlign || s['vertical-align']) {
            let vAlignVal = (s.verticalAlign || s['vertical-align']).toLowerCase();
            if (vAlignVal === 'center') vAlignVal = 'middle';
            if (vAlignVal === 'middle' || vAlignVal === 'bottom') attr.vAlign = vAlignVal as VertAlignType;
            else attr.vAlign = VertAlignType.top;
        }

        if (node.text) attr.text = node.text;
        if (s.fontFamily) attr.font = s.fontFamily.replace(/"/g, '');
        if (s.fontWeight) attr.bold = (parseInt(s.fontWeight) > 400).toString();
        if (s.italic) attr.italic = "true";
        if (s.underline) attr.underline = "true";
        if (s.strokeSize) {
            attr.strokeSize = (parseFloat(s.strokeSize) * FGUI_SCALE).toString();
            attr.strokeColor = this.formatColor(s.strokeColor || "#000000");
        }
        if (node.width > 0 && node.height > 0) attr.autoSize = "none";
    }

    private mapLoaderProperties(node: UINode, attr: Record<string, string>): void {
        const s = node.styles;
        // 填充模式从规则文件读取（不再写死 scaleFree）
        attr.fill = this._defaultFillMode.toString();
        if (s.src) attr.url = s.src;
    }

    private mapGraphProperties(node: UINode, attr: Record<string, string>): void {
        const s = node.styles;
        attr.type = "rect";

        const bgColor = s.fillColor || s.background || s.backgroundColor;
        if (bgColor && bgColor !== 'transparent' && bgColor !== 'none') {
            attr.fillColor = this.formatColor(bgColor);
        }

        if (s.cornerRadius || s['border-radius'] || s.borderRadius) {
            const rawCorner = parseFloat((s.cornerRadius || s['border-radius'] || s.borderRadius).toString().replace('px', ''));
            attr.corner = (rawCorner * FGUI_SCALE).toString();
        }

        const strokeColor = s.strokeColor || s['outline-color'] || s.outlineColor || s['border-color'] || s.borderColor;
        const strokeSize = s.strokeSize || s['outline-width'] || s.outlineWidth || s['border-width'] || s.borderWidth;

        if (strokeColor) attr.lineColor = this.formatColor(strokeColor);
        if (strokeSize) {
            attr.lineSize = (parseFloat(strokeSize.toString().replace('px', '')) * FGUI_SCALE).toString();
        }
    }

    private formatColor(color: string): string {
        if (!color) return "#000000";
        color = color.trim().toLowerCase();

        const namedColors: Record<string, string> = {
            black: "#000000", white: "#FFFFFF", red: "#FF0000", green: "#00FF00",
            blue: "#0000FF", gray: "#808080", grey: "#808080", yellow: "#FFFF00",
            cyan: "#00FFFF", magenta: "#FF00FF", silver: "#C0C0C0", maroon: "#800000",
            olive: "#808000", lime: "#00FF00", purple: "#800080", teal: "#008080",
            navy: "#000080", orange: "#FFA500", transparent: "#00000000"
        };

        if (namedColors[color]) return namedColors[color];

        if (color.startsWith('#')) {
            if (color.length === 4) {
                const r = color[1], g = color[2], b = color[3];
                return `#${r}${r}${g}${g}${b}${b}`;
            }
            return color;
        }

        if (color.startsWith('rgba')) {
            const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d\.]+))?\)/);
            if (m) {
                const r = parseInt(m[1]).toString(16).padStart(2, '0');
                const g = parseInt(m[2]).toString(16).padStart(2, '0');
                const b = parseInt(m[3]).toString(16).padStart(2, '0');
                if (m[4]) {
                    const a = Math.round(parseFloat(m[4]) * 255).toString(16).padStart(2, '0');
                    return `#${a}${r}${g}${b}`;
                }
                return `#${r}${g}${b}`;
            }
        }

        if (color.startsWith('rgb')) {
            const m = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (m) {
                const r = parseInt(m[1]).toString(16).padStart(2, '0');
                const g = parseInt(m[2]).toString(16).padStart(2, '0');
                const b = parseInt(m[3]).toString(16).padStart(2, '0');
                return `#${r}${g}${b}`;
            }
        }

        return color;
    }
}
