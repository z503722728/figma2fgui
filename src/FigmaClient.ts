import axios from 'axios';
import * as fs from 'fs-extra';
import * as path from 'path';
import { FGUI_SCALE } from './Common';

/**
 * FigmaClient: 负责与 Figma REST API 交互
 */
export class FigmaClient {
    private token: string;
    private fileKey: string;
    private baseUrl = 'https://api.figma.com/v1';

    constructor(token: string, fileKey: string) {
        this.token = token;
        this.fileKey = fileKey;
    }

    /**
     * 获取文件完整 JSON 树
     */
    public async getFile() {
        console.log(`📡 正在从 Figma 抓取文件数据: ${this.fileKey}...`);
        const response = await axios.get(`${this.baseUrl}/files/${this.fileKey}`, {
            params: { geometry: 'paths' },
            headers: { 'X-Figma-Token': this.token }
        });
        return response.data;
    }

    /**
     * 获取特定节点的数据
     */
    public async getNodes(ids: string[]) {
        console.log(`📡 正在抓取特定节点数据: ${ids.join(', ')}...`);
        const response = await axios.get(`${this.baseUrl}/files/${this.fileKey}/nodes`, {
            params: { ids: ids.join(','), geometry: 'paths' },
            headers: { 'X-Figma-Token': this.token }
        });
        return response.data;
    }

    /**
     * 获取文件版本号（用于缓存失效判断）
     */
    public async getFileVersion(): Promise<string> {
        const response = await axios.get(`${this.baseUrl}/files/${this.fileKey}`, {
            params: { depth: 1 },  // 最浅层级，只获取元数据
            headers: { 'X-Figma-Token': this.token }
        });
        return response.data.version || response.data.lastModified || 'unknown';
    }

    /**
     * 批量获取节点渲染链接
     * use_absolute_bounds=false 确保渲染包含阴影、模糊等超出逻辑边界的效果
     */
    public async getImageUrls(ids: string[], format: 'png' | 'svg' = 'png') {
        console.log(`🖼️ 正在请求 ${ids.length} 个节点的渲染链接 (format=${format})...`);
        const response = await axios.get(`${this.baseUrl}/images/${this.fileKey}`, {
            params: {
                ids: ids.join(','),
                format: format,
                scale: FGUI_SCALE,
                use_absolute_bounds: false
            },
            headers: { 'X-Figma-Token': this.token }
        });
        return response.data.images; // { "nodeId": "url" }
    }

    /**
     * 下载图片到本地（带超时保护）
     */
    public async downloadImage(url: string, destPath: string) {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000  // 30s timeout
        });
        await fs.writeFile(destPath, response.data);
    }
}
