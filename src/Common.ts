import { Rules } from './rules/RuleLoader';

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

/** 全局缩放倍率，从 rules/pipeline-config.json 读取，默认 2 */
export function getFgui_scale(): number {
    try {
        return Rules.pipeline().scale.value;
    } catch {
        return 2;
    }
}

// 模块级缓存，避免每次调用都解析 JSON
let _scale: number | null = null;
export function FGUI_SCALE_VALUE(): number {
    if (_scale === null) _scale = getFgui_scale();
    return _scale;
}

// 兼容旧代码的常量别名（值在首次读取后固定）
export const FGUI_SCALE: number = (() => {
    try { return Rules.pipeline().scale.value; } catch { return 2; }
})();

/**
 * 计算视觉 padding（阴影、模糊、描边溢出），与 PropertyMapper 保持一致。
 */
export function getVisualPadding(node: any): number {
    let padding = 0;
    const s = node.styles || {};

    if (s.strokeSize) {
        padding = Math.max(padding, Math.ceil(parseFloat(s.strokeSize) / 2));
    }

    if (s.filters && Array.isArray(s.filters)) {
        s.filters.forEach((f: any) => {
            if (f.type === 'DROP_SHADOW' || f.type === 'INNER_SHADOW') {
                const offX = Math.abs(f.offset?.x || 0);
                const offY = Math.abs(f.offset?.y || 0);
                const radius = f.radius || 0;
                const spread = f.spread || 0;
                padding = Math.max(padding, Math.ceil(Math.max(offX, offY) + radius + spread));
            } else if (f.type === 'LAYER_BLUR') {
                padding = Math.max(padding, Math.ceil(f.radius || 0));
            }
        });
    }

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

/**
 * 将字符串转为合法文件名（替换非法字符，截断至 20 字符）。
 */
export function sanitizeFileName(name: string): string {
    const sanitized = name.replace(/[\\/:*?"<>|]/g, '_');
    return sanitized.length > 20 ? sanitized.substring(0, 20) : sanitized;
}
