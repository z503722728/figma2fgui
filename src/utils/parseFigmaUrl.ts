/**
 * parseFigmaUrl: 从 Figma 分享链接中提取 FILE_KEY 和 NODE_ID。
 *
 * 支持的格式：
 *   https://www.figma.com/design/{fileKey}/{fileName}?node-id={nodeId}&...
 *   https://www.figma.com/file/{fileKey}/{fileName}?node-id={nodeId}&...
 *   https://www.figma.com/proto/{fileKey}/{fileName}?node-id={nodeId}&...
 *
 * Figma node-id 格式：
 *   URL 中为 "1-1083"（连字符），API 要求 "1:1083"（冒号）
 *   两种格式均支持，统一输出为冒号格式。
 */
export interface FigmaUrlInfo {
    fileKey: string;
    nodeId: string | null;
    /** 文件名（URL path 中的 slug，仅供参考）*/
    fileName: string | null;
}

export function parseFigmaUrl(input: string): FigmaUrlInfo {
    // 支持直接传 fileKey（不含斜杠）
    if (/^[a-zA-Z0-9]{22}$/.test(input.trim())) {
        return { fileKey: input.trim(), nodeId: null, fileName: null };
    }

    let url: URL;
    try {
        url = new URL(input.trim());
    } catch {
        throw new Error(`无效的 Figma URL：${input}`);
    }

    // 路径格式：/{type}/{fileKey}/{fileName-slug}
    const parts = url.pathname.split('/').filter(Boolean);
    // parts[0] = "design" | "file" | "proto"
    // parts[1] = fileKey
    // parts[2] = fileName slug（可选）
    if (parts.length < 2) {
        throw new Error(`无法从 URL 中解析 fileKey，路径格式不符：${url.pathname}`);
    }

    const fileKey = parts[1];
    const fileNameSlug = parts[2] ?? null;

    // node-id 参数：URL 中用 "-"，API 用 ":"
    let nodeId: string | null = url.searchParams.get('node-id');
    if (nodeId) {
        nodeId = nodeId.replace(/-/g, ':');
    }

    return { fileKey, nodeId, fileName: fileNameSlug ? decodeURIComponent(fileNameSlug) : null };
}
