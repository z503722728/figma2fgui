import { ObjectType, LoaderFillType, AlignType, VertAlignType } from "../models/FGUIEnum";
import { UINode } from "../models/UINode";
import { getVisualPadding, FGUI_SCALE } from "../Common";

/**
 * PropertyMapper: Translates CSS and React properties into FGUI-specific attributes.
 * Uses reverse-engineered rules from lib.js.
 */
export class PropertyMapper {
    /**
     * Maps a UINode's raw styles and props into FGUI XML attributes.
     */
    public mapAttributes(node: UINode, assignedId?: string): Record<string, string> {
        // Log style keys for debugging if necessary
        const s = node.styles;
        // 💡 PADDING FIX: Force padding to 0. Since we download images using use_absolute_bounds: true,
        // the PNG matches the logical node size exactly. We should NOT add visual padding for shadows/strokes
        // that are excluded from the image anyway.
        const padding = 0; // getVisualPadding(node);
        
        // 💡 SCALING: Apply global FGUI_SCALE to all spatial coordinates and sizes
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

        // 1. Map Common Visual Properties
        if (s.opacity) {
            attr.alpha = s.opacity;
        }

        if (node.rotation) {
            attr.rotation = node.rotation.toString();
        }

        // 2. Type-specific Mapping
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

        // 3. Map Visual Container Properties (for Graph OR Component/Group with visual styles)
        if (node.type === ObjectType.Graph || node.type === ObjectType.Component || node.type === ObjectType.Group) {
            this.mapGraphProperties(node, attr);
        }

        return attr;
    }

    private mapTextProperties(node: UINode, attr: Record<string, string>): void {
        const s = node.styles;
        // 💡 SCALING: Font size
        const rawFontSize = parseFloat((s['font-size'] || s.fontSize || "12").toString());
        attr.fontSize = Math.round(rawFontSize * FGUI_SCALE).toString();
        
        attr.color = this.formatColor(s.color || "#000000");
        
        // Alignment mapping
        if (s['text-align'] || s.align || s.textAlign) {
            const alignVal = (s['text-align'] || s.align || s.textAlign).toLowerCase();
            if (alignVal === 'center' || alignVal === 'right') {
                attr.align = alignVal as AlignType;
            } else if (alignVal === 'justify') {
                attr.align = AlignType.left; // FGUI text doesn't support justify standardly, fallback to left
            } else {
                attr.align = AlignType.left;
            }
        }
        
        if (s.verticalAlign || s['vertical-align']) {
            let vAlignVal = (s.verticalAlign || s['vertical-align']).toLowerCase();
            if (vAlignVal === 'center') vAlignVal = 'middle'; // Map Figma 'center' to FGUI 'middle'
            
            if (vAlignVal === 'middle' || vAlignVal === 'bottom') {
                attr.vAlign = vAlignVal as VertAlignType;
            } else {
                attr.vAlign = VertAlignType.top;
            }
        }
        
        if (node.text) {
            attr.text = node.text;
        }

        if (s.fontFamily) attr.font = s.fontFamily.replace(/"/g, '');
        if (s.fontWeight) attr.bold = (parseInt(s.fontWeight) > 400).toString();
        if (s.italic) attr.italic = "true";
        if (s.underline) attr.underline = "true";
        if (s.strokeSize) {
            // 💡 SCALING: Stroke size
            attr.strokeSize = (parseFloat(s.strokeSize) * FGUI_SCALE).toString();
            attr.strokeColor = this.formatColor(s.strokeColor || "#000000");
        }

        // 💡 autoSize logic: if size is specified (usually from Figma), set to none
        // Default FGUI behavior for text without autoSize is often 'both' or 'height'
        if (node.width > 0 && node.height > 0) {
            attr.autoSize = "none";
        }
    }

    private mapLoaderProperties(node: UINode, attr: Record<string, string>): void {
        const s = node.styles;
        attr.fill = LoaderFillType.scaleFree.toString(); 
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
            // 💡 SCALING: Corner radius
            const rawCorner = parseFloat((s.cornerRadius || s['border-radius'] || s.borderRadius).toString().replace('px', ''));
            attr.corner = (rawCorner * FGUI_SCALE).toString();
        }

        // 4. Map Stroke (lineSize, lineColor)
        const strokeColor = s.strokeColor || s['outline-color'] || s.outlineColor || s['border-color'] || s.borderColor;
        const strokeSize = s.strokeSize || s['outline-width'] || s.outlineWidth || s['border-width'] || s.borderWidth;
        
        if (strokeColor) attr.lineColor = this.formatColor(strokeColor);
        if (strokeSize) {
            // 💡 SCALING: Line size
            attr.lineSize = (parseFloat(strokeSize.toString().replace('px', '')) * FGUI_SCALE).toString();
        }
    }

    /**
     * Converts CSS colors (rgba, hex, name) to FGUI compatible hex.
     */
    private formatColor(color: string): string {
        if (!color) return "#000000";
        color = color.trim().toLowerCase();

        const namedColors: Record<string, string> = {
            black: "#000000",
            white: "#FFFFFF",
            red: "#FF0000",
            green: "#00FF00",
            blue: "#0000FF",
            gray: "#808080",
            grey: "#808080",
            yellow: "#FFFF00",
            cyan: "#00FFFF",
            magenta: "#FF00FF",
            silver: "#C0C0C0",
            maroon: "#800000",
            olive: "#808000",
            lime: "#00FF00",
            purple: "#800080",
            teal: "#008080",
            navy: "#000080",
            orange: "#FFA500",
            transparent: "#00000000"
        };

        if (namedColors[color]) {
            return namedColors[color];
        }

        // Hex short expansion #RGB -> #RRGGBB
        if (color.startsWith('#')) {
            if (color.length === 4) {
                const r = color[1];
                const g = color[2];
                const b = color[3];
                return `#${r}${r}${g}${g}${b}${b}`;
            }
            return color; // Return as is if already #RRGGBB or #AARRGGBB
        }

        if (color.startsWith('rgba')) {
            const matches = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d\.]+))?\)/);
            if (matches) {
                const r = parseInt(matches[1]).toString(16).padStart(2, '0');
                const g = parseInt(matches[2]).toString(16).padStart(2, '0');
                const b = parseInt(matches[3]).toString(16).padStart(2, '0');
                if (matches[4]) {
                    const a = Math.round(parseFloat(matches[4]) * 255).toString(16).padStart(2, '0');
                    return `#${a}${r}${g}${b}`;
                }
                return `#${r}${g}${b}`;
            }
        }
        
        if (color.startsWith('rgb')) {
            const matches = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (matches) {
                const r = parseInt(matches[1]).toString(16).padStart(2, '0');
                const g = parseInt(matches[2]).toString(16).padStart(2, '0');
                const b = parseInt(matches[3]).toString(16).padStart(2, '0');
                return `#${r}${g}${b}`;
            }
        }

        // Default fallback if parsing fails but it's not empty
        return color;
    }
}
