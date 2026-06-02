import * as fs from 'fs-extra';
import * as path from 'path';
import { FigmaClient } from './FigmaClient';
import { UINode, ResourceInfo } from './models/UINode';
import { ObjectType } from './models/FGUIEnum';
import { sanitizeFileName, FGUI_SCALE, getVisualPadding } from './Common';
import { Rules } from './rules/RuleLoader';

interface CacheManifest {
    figmaVersion: string;
    lastModified: string;
    files: Record<string, { nodeId: string }>;
}

interface PipelineItem {
    node: UINode;
    sourceId: string;
    fileName: string;
    resId: string;
    suffix: string;
}

async function parallelLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let idx = 0;
    const run = async () => {
        while (idx < tasks.length) {
            const i = idx++;
            results[i] = await tasks[i]();
        }
    };
    await Promise.all(Array(Math.min(limit, tasks.length)).fill(0).map(() => run()));
    return results;
}

/**
 * ImagePipeline: 批量抓取 Figma SSR 图片并并发下载。
 *
 * 改进（design2fgui）：
 * - BATCH_SIZE / CONCURRENCY / BATCH_DELAY_MS 从 rules/pipeline-config.json 读取。
 */
export class ImagePipeline {
    private queue: PipelineItem[] = [];
    private client: FigmaClient;
    private imgDir: string;
    private figmaVersion: string;
    private manifest: CacheManifest | null = null;
    private manifestPath: string;

    private readonly BATCH_SIZE: number;
    private readonly CONCURRENCY: number;
    private readonly BATCH_DELAY_MS: number;

    constructor(client: FigmaClient, imgDir: string, figmaVersion: string) {
        this.client = client;
        this.imgDir = imgDir;
        this.figmaVersion = figmaVersion;
        this.manifestPath = path.join(imgDir, '.cache_manifest.json');

        try {
            const cfg = Rules.pipeline().imagePipeline;
            this.BATCH_SIZE = cfg.batchSize;
            this.CONCURRENCY = cfg.concurrency;
            this.BATCH_DELAY_MS = cfg.batchDelayMs;
        } catch {
            this.BATCH_SIZE = 50;
            this.CONCURRENCY = 5;
            this.BATCH_DELAY_MS = 100;
        }
    }

    public enqueue(node: UINode, suffix: string = ''): ResourceInfo {
        const sourceId = node.sourceId || node.id;
        const nodeIdStr = sourceId.replace(/:/g, '_');
        const fileName = `${sanitizeFileName(node.name)}${suffix}_${nodeIdStr}.png`;
        const resId = `img_${sanitizeFileName(node.name)}${suffix.replace(/[^a-zA-Z0-9]/g, '_')}_${nodeIdStr}`;

        this.queue.push({ node, sourceId, fileName, resId, suffix });

        const padding = getVisualPadding(node);
        return {
            id: resId,
            name: fileName,
            type: 'image',
            width: Math.round((node.width + padding * 2) * FGUI_SCALE),
            height: Math.round((node.height + padding * 2) * FGUI_SCALE),
        };
    }

    public isAtomicVisual(node: UINode): boolean {
        if (node.type === ObjectType.Image) return true;
        return node.children != null && node.children.length > 0 && this.allDescendantsAreShapes(node);
    }

    public scanAndEnqueue(nodes: UINode[], allResources: ResourceInfo[]): void {
        const visit = (node: UINode) => {
            if (node.visible === false) return;
            if (node.src) {
                if (node.multiLooks) this.enqueueMultiLooks(node, node.src, allResources);
                return;
            }
            if (node.asComponent) {
                if (node.children) node.children.forEach(visit);
                return;
            }
            const isLeaf = this.isVisualLeaf(node);
            if (isLeaf) {
                const res = this.enqueue(node);
                allResources.push(res);
                node.src = res.id;
                node.fileName = 'img/' + res.name;
                if (node.multiLooks) this.enqueueMultiLooks(node, res.id, allResources);
                return;
            }
            if (node.children) node.children.forEach(visit);
        };
        nodes.forEach(visit);
    }

    private enqueueMultiLooks(node: UINode, baseResId: string, allResources: ResourceInfo[]): void {
        if (!node.multiLooks) return;
        const pageIds = Object.keys(node.multiLooks).map(Number);
        const lookResMap: Record<number, string> = { 0: baseResId };

        for (const pageId of pageIds) {
            const lookData = node.multiLooks[pageId];
            if (lookData && lookData.sourceId) {
                const lookNode: UINode = { ...node, sourceId: lookData.sourceId, multiLooks: undefined };
                const lookRes = this.enqueue(lookNode, `_page${pageId}`);
                allResources.push(lookRes);
                lookResMap[pageId] = lookRes.id;
            }
        }

        const gear = node.gears?.find(g => g.type === 'gearIcon');
        if (gear) {
            const isButton = gear.controller === 'button';
            if (isButton) {
                const variantResId = pageIds.map(p => lookResMap[p]).find(r => r && r !== baseResId) || baseResId;
                gear.values = [baseResId, variantResId, baseResId, baseResId].join('|');
            } else {
                const maxPage = Math.max(...pageIds, 3);
                const values: string[] = [];
                for (let p = 0; p <= maxPage; p++) values.push(lookResMap[p] || baseResId);
                gear.values = values.join('|');
            }
        }
    }

    public async execute(): Promise<void> {
        if (this.queue.length === 0) {
            console.log('🖼️ ImagePipeline: No images to process.');
            return;
        }

        await fs.ensureDir(this.imgDir);
        this.manifest = await this.loadManifest();
        const versionMatch = this.manifest && this.manifest.figmaVersion === this.figmaVersion;
        const forceDownload = process.env.FORCE_DOWNLOAD === 'true';

        let itemsToProcess: PipelineItem[];
        if (versionMatch && !forceDownload) {
            itemsToProcess = this.queue.filter(item => {
                const cached = this.manifest!.files[item.fileName];
                return !cached || !fs.existsSync(path.join(this.imgDir, item.fileName));
            });
            console.log(`🖼️ ImagePipeline: ${this.queue.length} total, ${this.queue.length - itemsToProcess.length} cached, ${itemsToProcess.length} to download.`);
        } else {
            itemsToProcess = [...this.queue];
            console.log(`🖼️ ImagePipeline: ${forceDownload ? 'FORCE_DOWNLOAD=true' : 'Figma version changed'}, downloading all ${itemsToProcess.length} images.`);
        }

        if (itemsToProcess.length === 0) {
            console.log('✅ ImagePipeline: All images are cached.');
            return;
        }

        const urlMap = new Map<string, string>();
        const batches = this.chunk(itemsToProcess, this.BATCH_SIZE);
        console.log(`📡 ImagePipeline: Fetching URLs in ${batches.length} batch(es)...`);

        for (let i = 0; i < batches.length; i++) {
            try {
                const urls = await this.client.getImageUrls(batches[i].map(it => it.sourceId), 'png');
                for (const [id, url] of Object.entries(urls)) {
                    if (url) urlMap.set(id, url as string);
                }
            } catch (err) {
                console.error(`❌ ImagePipeline: Batch ${i + 1} URL fetch failed:`, err);
            }
            if (i < batches.length - 1) await this.delay(this.BATCH_DELAY_MS);
        }

        const downloadTasks = itemsToProcess
            .filter(item => urlMap.has(item.sourceId))
            .map(item => () => this.downloadWithRetry(
                urlMap.get(item.sourceId)!,
                path.join(this.imgDir, item.fileName),
                item.fileName
            ));

        const missing = itemsToProcess.filter(item => !urlMap.has(item.sourceId));
        if (missing.length > 0) {
            console.warn(`⚠️ ImagePipeline: ${missing.length} nodes returned no URL.`);
            missing.forEach(item => console.warn(`   - ${item.fileName} (${item.sourceId})`));
        }

        console.log(`⬇️ ImagePipeline: Downloading ${downloadTasks.length} images (concurrency=${this.CONCURRENCY})...`);
        await parallelLimit(downloadTasks, this.CONCURRENCY);
        await this.saveManifest(itemsToProcess);
        console.log(`✅ ImagePipeline: Done. ${downloadTasks.length} images downloaded.`);
    }

    private isVisualLeaf(node: UINode): boolean {
        if (node.type === ObjectType.Image) return true;
        if (node.type === ObjectType.Graph) return !!(node.styles?.fillColor || node.styles?.strokeColor);

        const isContainer = (
            node.type === ObjectType.Component ||
            node.type === ObjectType.Group ||
            node.type === ObjectType.Loader
        );
        if (!isContainer) return false;

        const hasVisualProps = !!(
            node.styles?.fillColor || node.styles?.strokeColor ||
            node.styles?.imageFill || (node.styles?.filters && node.styles.filters.length > 0)
        );
        const hasFillPaths = Array.isArray(node.customProps?.fillGeometry) && node.customProps.fillGeometry.length > 0;

        if ((hasVisualProps || hasFillPaths) && !this.hasTextChildren(node)) return true;

        if (node.children && node.children.length > 0 && this.allDescendantsAreShapes(node)) {
            console.log(`🧩 isVisualLeaf: Treating "${node.name}" as atomic unit (all children are shapes)`);
            return true;
        }

        if (node.children && node.children.length > 0 && !node.asComponent && this.hasMaskDescendants(node)) {
            console.log(`🎭 isVisualLeaf: Treating "${node.name}" as atomic unit (contains mask descendants)`);
            return true;
        }

        return false;
    }

    private allDescendantsAreShapes(node: UINode): boolean {
        if (!node.children || node.children.length === 0) return true;
        for (const child of node.children) {
            if (child.type === ObjectType.Text || child.type === ObjectType.RichText || child.type === ObjectType.InputText) return false;
            if (child.type === ObjectType.Button || child.type === ObjectType.Label ||
                child.type === ObjectType.ProgressBar || child.type === ObjectType.Slider ||
                child.type === ObjectType.ComboBox || child.type === ObjectType.List) return false;
            if (child.type === ObjectType.Image || child.type === ObjectType.Graph) continue;
            if (child.asComponent) return false;
            if (!this.allDescendantsAreShapes(child)) return false;
        }
        return true;
    }

    private hasMaskDescendants(node: UINode): boolean {
        if (!node.children) return false;
        for (const child of node.children) {
            if (child.customProps?.isMask) return true;
            if (this.hasMaskDescendants(child)) return true;
        }
        return false;
    }

    private hasTextChildren(node: UINode): boolean {
        if (!node.children) return false;
        for (const child of node.children) {
            if (child.type === ObjectType.Text) return true;
            if (child.asComponent) continue;
            if (this.hasTextChildren(child)) return true;
        }
        return false;
    }

    private async loadManifest(): Promise<CacheManifest | null> {
        try {
            if (await fs.pathExists(this.manifestPath)) {
                return JSON.parse(await fs.readFile(this.manifestPath, 'utf-8')) as CacheManifest;
            }
        } catch { console.warn('⚠️ ImagePipeline: Failed to load cache manifest.'); }
        return null;
    }

    private async saveManifest(processedItems: PipelineItem[]): Promise<void> {
        const existingFiles = this.manifest?.files || {};
        for (const item of processedItems) existingFiles[item.fileName] = { nodeId: item.sourceId };
        await fs.writeFile(this.manifestPath, JSON.stringify({
            figmaVersion: this.figmaVersion,
            lastModified: new Date().toISOString(),
            files: existingFiles,
        }, null, 2));
    }

    private async downloadWithRetry(url: string, destPath: string, label: string, retries = 3): Promise<void> {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try { await this.client.downloadImage(url, destPath); return; }
            catch (err) {
                if (attempt === retries) console.error(`❌ ImagePipeline: Failed to download ${label} after ${retries} retries.`);
                else { await this.delay(attempt * 500); }
            }
        }
    }

    private chunk<T>(arr: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
        return chunks;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
