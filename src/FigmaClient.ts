import axios from 'axios';
import * as fs from 'fs-extra';
import * as path from 'path';

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
     * 批量获取节点渲染链接
     */
    public async getImageUrls(ids: string[], format: 'png' | 'svg' = 'png') {
        console.log(`🖼️ 正在请求 ${ids.length} 个节点的渲染链接...`);
        const response = await axios.get(`${this.baseUrl}/images/${this.fileKey}`, {
            params: {
                ids: ids.join(','),
                format: format,
                scale: 2 // 2倍图保证清晰度
            },
            headers: { 'X-Figma-Token': this.token }
        });
        return response.data.images; // { "nodeId": "url" }
    }

    /**
     * 下载图片到本地
     */
    public async downloadImage(url: string, destPath: string) {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        await fs.writeFile(destPath, response.data);
    }
}
