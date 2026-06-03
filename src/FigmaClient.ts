import axios from 'axios';
import * as fs from 'fs-extra';
import { FGUI_SCALE } from './Common';

export class FigmaClient {
    private token: string;
    private fileKey: string;
    private baseUrl = 'https://api.figma.com/v1';

    constructor(token: string, fileKey: string) {
        this.token = token;
        this.fileKey = fileKey;
    }

    public async getFile() {
        console.log(`📡 正在从 Figma 抓取文件数据: ${this.fileKey}...`);
        const response = await axios.get(`${this.baseUrl}/files/${this.fileKey}`, {
            params: { geometry: 'paths' },
            headers: { 'X-Figma-Token': this.token }
        });
        return response.data;
    }

    public async getNodes(ids: string[]) {
        console.log(`📡 正在抓取特定节点数据: ${ids.join(', ')}...`);
        const response = await axios.get(`${this.baseUrl}/files/${this.fileKey}/nodes`, {
            params: { ids: ids.join(','), geometry: 'paths' },
            headers: { 'X-Figma-Token': this.token }
        });
        return response.data;
    }

    public async getFileVersion(): Promise<string> {
        const response = await axios.get(`${this.baseUrl}/files/${this.fileKey}`, {
            params: { depth: 1 },
            headers: { 'X-Figma-Token': this.token }
        });
        return response.data.version || response.data.lastModified || 'unknown';
    }

    public async getImageUrls(ids: string[], format: 'png' | 'svg' = 'png') {
        console.log(`🖼️ 正在请求 ${ids.length} 个节点的渲染链接 (format=${format})...`);
        const response = await axios.get(`${this.baseUrl}/images/${this.fileKey}`, {
            params: {
                ids: ids.join(','),
                format,
                scale: FGUI_SCALE,
                use_absolute_bounds: false
            },
            headers: { 'X-Figma-Token': this.token }
        });
        return response.data.images;
    }

    /**
     * 渲染节点为低分辨率预览图（用于 AI 分析截图，不用于游戏资源）。
     * scale=0.25 → 1920px 界面输出约 480px 宽，体积小、速度快。
     */
    public async getPreviewUrl(nodeId: string): Promise<string | null> {
        try {
            const response = await axios.get(`${this.baseUrl}/images/${this.fileKey}`, {
                params: { ids: nodeId, format: 'png', scale: 0.25 },
                headers: { 'X-Figma-Token': this.token }
            });
            return response.data.images?.[nodeId] ?? null;
        } catch (e: any) {
            console.warn(`⚠️  节点预览图渲染失败: ${e.message}`);
            return null;
        }
    }

    public async downloadImage(url: string, destPath: string) {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000
        });
        await fs.writeFile(destPath, response.data);
    }
}
