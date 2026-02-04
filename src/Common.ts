export interface ExportConfig {
    reactFile: string;
    outPath: string;
    packName: string;
    subCom: string;
}

export enum ItemType {
    IMAGE = 'image',
    COMPONENT = 'component',
    TEXT = 'text'
}

/**
 * Calculates visual padding required to avoid clipping of strokes and shadows.
 * @param node UI node with styles
 * @returns Padding value in pixels
 */
export function getVisualPadding(node: any): number {
    let padding = 0;
    const s = node.styles || {};

    // 1. Stroke padding (half of stroke size extends outwards)
    if (s.strokeSize) {
        padding = Math.max(padding, Math.ceil(parseFloat(s.strokeSize) / 2));
    }

    // 2. Filter padding (Shadows)
    if (s.filters && Array.isArray(s.filters)) {
        s.filters.forEach((f: any) => {
            if (f.type === 'DROP_SHADOW' || f.type === 'INNER_SHADOW') {
                const offX = Math.abs(f.offset?.x || 0);
                const offY = Math.abs(f.offset?.y || 0);
                const radius = f.radius || 0;
                const spread = f.spread || 0;
                // Rough estimation: offset + radius + spread
                padding = Math.max(padding, Math.ceil(Math.max(offX, offY) + radius + spread));
            } else if (f.type === 'LAYER_BLUR') {
                padding = Math.max(padding, Math.ceil(f.radius || 0));
            }
        });
    }

    // Also check mergedPaths for vector groups
    if (node.customProps?.mergedPaths) {
        node.customProps.mergedPaths.forEach((p: any) => {
            if (p.strokeSize) {
                padding = Math.max(padding, Math.ceil(p.strokeSize / 2));
            }
            if (p.filters) {
                p.filters.forEach((f: any) => {
                    const offX = Math.abs(f.offset?.x || 0);
                    const offY = Math.abs(f.offset?.y || 0);
                    const radius = f.radius || 0;
                    const spread = f.spread || 0;
                    padding = Math.max(padding, Math.ceil(Math.max(offX, offY) + radius + spread));
                });
            }
        });
    }

    return padding;
}
