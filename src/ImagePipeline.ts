import * as fs from 'fs-extra';
import * as path from 'path';
import { FigmaClient } from './FigmaClient';
import { UINode, ResourceInfo } from './models/UINode';
import { ObjectType } from './models/FGUIEnum';
import { sanitizeFileName, FGUI_SCALE, getVisualPadding } from './Common';

/**
 * Cache manifest structure for version-aware caching.
 */
interface CacheManifest {
    figmaVersion: string;
    lastModified: string;
    files: Record<string, { nodeId: string }>;
}

/**
 * An item queued for server-side rendering and download.
 */
interface PipelineItem {
    node: UINode;
    sourceId: string;       // Figma node ID to send to SSR
    fileName: string;       // Output filename (e.g. "BtnBg_1279_7411.png")
    resId: string;          // FGUI resource ID
    suffix: string;         // Optional suffix for multi-state (e.g. "_page1")
}

/**
 * Concurrency-limited parallel executor.
 * No external dependencies — 10 lines, does the job.
 */
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
 * ImagePipeline: Collects UINodes, batch-fetches SSR URLs from Figma,
 * downloads PNGs in parallel, and returns ResourceInfo[] for package.xml.
 *
 * Replaces: renderSvg, scanForVectors, scanForBitmaps, VectorMerger
 */
export class ImagePipeline {
    private queue: PipelineItem[] = [];
    private client: FigmaClient;
    private imgDir: string;
    private figmaVersion: string;
    private manifest: CacheManifest | null = null;
    private manifestPath: string;

    private static readonly BATCH_SIZE = 50;
    private static readonly CONCURRENCY = 5;
    private static readonly BATCH_DELAY_MS = 100;
    private static readonly SCALE = FGUI_SCALE;  // 2x for retina clarity
    
    constructor(client: FigmaClient, imgDir: string, figmaVersion: string) {
        this.client = client;
        this.imgDir = imgDir;
        this.figmaVersion = figmaVersion;
        this.manifestPath = path.join(imgDir, '.cache_manifest.json');
    }

    /**
     * Enqueue a node for SSR rendering.
     * Returns the ResourceInfo that will be populated after execute().
     */
    public enqueue(node: UINode, suffix: string = ''): ResourceInfo {
        const sourceId = node.sourceId || node.id;
        const nodeIdStr = sourceId.replace(/:/g, '_');
        const fileName = `${sanitizeFileName(node.name)}${suffix}_${nodeIdStr}.png`;
        const resId = `img_${sanitizeFileName(node.name)}${suffix.replace(/[^a-zA-Z0-9]/g, '_')}_${nodeIdStr}`;

        this.queue.push({ node, sourceId, fileName, resId, suffix });

        // 计算效果 padding（阴影、模糊、描边溢出），与 PropertyMapper 保持一致
        const padding = getVisualPadding(node);

        return {
            id: resId,
            name: fileName,
            type: 'image',
            width: Math.round((node.width + padding * 2) * ImagePipeline.SCALE),
            height: Math.round((node.height + padding * 2) * ImagePipeline.SCALE),
        };
    }

    /**
     * Public check: is this node an atomic visual unit (all descendants are shapes)?
     * Used by index.ts to skip scanning pure-shape sub-components.
     */
    public isAtomicVisual(node: UINode): boolean {
        if (node.type === ObjectType.Image) return true;
        return node.children != null && node.children.length > 0 && this.allDescendantsAreShapes(node);
    }

    /**
     * Recursively scan the node tree and enqueue all visual leaf nodes.
     * This replaces both scanForVectors and scanForBitmaps.
     */
    public scanAndEnqueue(nodes: UINode[], allResources: ResourceInfo[]): void {
        const visit = (node: UINode) => {
            if (node.visible === false) return;

            // Already has a resource assigned (e.g. from manual PNG matching)
            // 💡 但如果有 multiLooks，仍需处理变体图片的入队
            if (node.src) {
                if (node.multiLooks) {
                    this.enqueueMultiLooks(node, node.src, allResources);
                }
                return;
            }

            // 💡 asComponent 节点（根组件、已提取的子组件）不应被当作图片整体渲染。
            // 它们需要递归扫描子节点，让每个子节点独立获取图片资源。
            // 否则 isVisualLeaf 可能因为节点有 fill 且无直接文本子节点而误判为整体图片，
            // 导致所有子节点不被扫描、没有 src。
            if (node.asComponent) {
                if (node.children) node.children.forEach(visit);
                return;
            }

            const isVisualLeaf = this.isVisualLeaf(node);

            if (isVisualLeaf) {
                // 1. Enqueue base look
                const res = this.enqueue(node);
                allResources.push(res);
                node.src = res.id;
                node.fileName = 'img/' + res.name;

                // 2. Enqueue multi-state looks
                if (node.multiLooks) {
                    this.enqueueMultiLooks(node, res.id, allResources);
                }

                return; // Treat as leaf — don't recurse into children
            }

            // Recurse into children
            if (node.children) node.children.forEach(visit);
        };

        nodes.forEach(visit);
    }

    /**
     * 处理 multiLooks 变体图片入队：为每个视觉变体创建独立的 SSR 图片资源，
     * 并更新 gearIcon 的 values 属性。
     * @param node 拥有 multiLooks 的节点
     * @param baseResId 基础（默认）图片资源 ID
     * @param allResources 全局资源列表
     */
    private enqueueMultiLooks(node: UINode, baseResId: string, allResources: ResourceInfo[]): void {
        if (!node.multiLooks) return;

        const pageIds = Object.keys(node.multiLooks).map(Number);
        const lookResMap: Record<number, string> = { 0: baseResId };

        for (const pageId of pageIds) {
            const lookData = node.multiLooks[pageId];
            if (lookData && lookData.sourceId) {
                const lookNode: UINode = {
                    ...node,
                    sourceId: lookData.sourceId,
                    multiLooks: undefined,
                };
                const lookRes = this.enqueue(lookNode, `_page${pageId}`);
                allResources.push(lookRes);
                lookResMap[pageId] = lookRes.id;
            }
        }

        // Update gearIcon values
        const gear = node.gears?.find(g => g.type === 'gearIcon');
        if (gear) {
            // 💡 Button 控制器页映射: 0=up, 1=down, 2=over, 3=selectedOver
            // 对于 Button，所有视觉变体应统一映射到 down(1)，
            // 页 0-2 (up/down/over) 全部使用基础图标。
            const isButton = gear.controller === 'button';

            if (isButton) {
                // 取第一个非默认变体作为 down 图标
                const variantResId = pageIds.map(p => lookResMap[p]).find(r => r && r !== baseResId) || baseResId;
                gear.values = [baseResId, variantResId, baseResId, baseResId].join('|');
            } else {
                const maxPage = Math.max(...pageIds, 3);
                const values: string[] = [];
                for (let p = 0; p <= maxPage; p++) {
                    values.push(lookResMap[p] || baseResId);
                }
                gear.values = values.join('|');
            }
        }
    }

    /**
     * Execute the pipeline: batch fetch URLs, parallel download, update cache.
     */
    public async execute(): Promise<void> {
        if (this.queue.length === 0) {
            console.log('🖼️ ImagePipeline: No images to process.');
            return;
        }

        await fs.ensureDir(this.imgDir);

        // 1. Load cache manifest
        this.manifest = await this.loadManifest();
        const versionMatch = this.manifest && this.manifest.figmaVersion === this.figmaVersion;
        const forceDownload = process.env.FORCE_DOWNLOAD === 'true';

        // 2. Filter out already cached items
        let itemsToProcess: PipelineItem[];
        if (versionMatch && !forceDownload) {
            itemsToProcess = this.queue.filter(item => {
                const cached = this.manifest!.files[item.fileName];
                const fileExists = fs.existsSync(path.join(this.imgDir, item.fileName));
                return !cached || !fileExists;
            });
            console.log(`🖼️ ImagePipeline: ${this.queue.length} total, ${this.queue.length - itemsToProcess.length} cached, ${itemsToProcess.length} to download.`);
        } else {
            itemsToProcess = [...this.queue];
            if (forceDownload) {
                console.log(`🖼️ ImagePipeline: FORCE_DOWNLOAD=true, downloading all ${itemsToProcess.length} images.`);
            } else {
                console.log(`🖼️ ImagePipeline: Figma version changed, downloading all ${itemsToProcess.length} images.`);
            }
        }

        if (itemsToProcess.length === 0) {
            console.log('✅ ImagePipeline: All images are cached. Skipping downloads.');
            return;
        }

        // 3. Batch fetch URLs from Figma SSR API
        const urlMap = new Map<string, string>(); // sourceId -> URL
        const batches = this.chunk(itemsToProcess, ImagePipeline.BATCH_SIZE);

        console.log(`📡 ImagePipeline: Fetching URLs in ${batches.length} batch(es)...`);

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const ids = batch.map(item => item.sourceId);
            
            try {
                const urls = await this.client.getImageUrls(ids, 'png');
                for (const [id, url] of Object.entries(urls)) {
                    if (url) urlMap.set(id, url as string);
                }
            } catch (err) {
                console.error(`❌ ImagePipeline: Batch ${i + 1} URL fetch failed:`, err);
            }

            // Rate limit delay between batches
            if (i < batches.length - 1) {
                await this.delay(ImagePipeline.BATCH_DELAY_MS);
            }
        }

        // 4. Download images in parallel with concurrency limit
        const downloadTasks = itemsToProcess
            .filter(item => urlMap.has(item.sourceId))
            .map(item => () => this.downloadWithRetry(
                urlMap.get(item.sourceId)!,
                path.join(this.imgDir, item.fileName),
                item.fileName
            ));

        const missingUrls = itemsToProcess.filter(item => !urlMap.has(item.sourceId));
        if (missingUrls.length > 0) {
            console.warn(`⚠️ ImagePipeline: ${missingUrls.length} nodes returned no URL from Figma.`);
            missingUrls.forEach(item => console.warn(`   - ${item.fileName} (sourceId: ${item.sourceId})`));
        }

        console.log(`⬇️ ImagePipeline: Downloading ${downloadTasks.length} images (concurrency=${ImagePipeline.CONCURRENCY})...`);
        await parallelLimit(downloadTasks, ImagePipeline.CONCURRENCY);

        // 5. Update cache manifest
        await this.saveManifest(itemsToProcess);

        console.log(`✅ ImagePipeline: Done. ${downloadTasks.length} images downloaded.`);
    }

    /**
     * Determines if a node should be treated as a visual leaf (sent to SSR as one image).
     * 
     * Key insight: Figma Dev Mode shows INSTANCE/COMPONENT as atomic "Icons"
     * when all their children are pure shapes. We mirror this behavior:
     * if a container's descendants are ALL graphical primitives (no text, 
     * no interactive sub-components), treat it as a single renderable unit.
     */
    private isVisualLeaf(node: UINode): boolean {
        // Explicit Image type — always render (RECTANGLE, VECTOR, BOOLEAN_OPERATION, etc.)
        if (node.type === ObjectType.Image) return true;

        // Graph fallback with visual properties
        if (node.type === ObjectType.Graph) {
            return !!(node.styles?.fillColor || node.styles?.strokeColor);
        }

        // Container types
        const isContainer = (
            node.type === ObjectType.Component ||
            node.type === ObjectType.Group ||
            node.type === ObjectType.Loader
        );

        if (!isContainer) return false;

        // Case 1: Container has its own visual fills + no text children → visual leaf
        const hasVisualProps = !!(
            node.styles?.fillColor ||
            node.styles?.strokeColor ||
            node.styles?.imageFill ||
            (node.styles?.filters && node.styles.filters.length > 0)
        );
        const hasFillPaths = Array.isArray(node.customProps?.fillGeometry) && node.customProps.fillGeometry.length > 0;

        if ((hasVisualProps || hasFillPaths) && !this.hasTextChildren(node)) {
            return true;
        }

        // Case 2: 💡 Container whose children are ALL graphical shapes
        // (matches Figma Dev Mode "Icons" behavior for INSTANCE/COMPONENT nodes)
        // If a container has children but ALL of them are pure shapes (Image type)
        // or nested shape groups, treat the container as a single renderable unit.
        if (node.children && node.children.length > 0) {
            const allChildrenAreShapes = this.allDescendantsAreShapes(node);
            if (allChildrenAreShapes) {
                console.log(`🧩 isVisualLeaf: Treating "${node.name}" as atomic unit (all children are shapes)`);
                return true;
            }
        }

        // Case 3: 💡 Container with mask descendants (alpha mask / clipping effects)
        // Figma 的 alpha mask + clipsContent 产生的视觉效果无法用独立子元素复现，
        // 必须由 Figma SSR 整体渲染为一张图片。
        // 排除 asComponent 节点：根组件和已提取的子组件不应被当作图片，
        // 它们内部的 mask 子元素会被 ImagePipeline 单独处理。
        if (node.children && node.children.length > 0
            && !node.asComponent
            && this.hasMaskDescendants(node)) {
            console.log(`🎭 isVisualLeaf: Treating "${node.name}" as atomic unit (contains mask descendants)`);
            return true;
        }

        return false;
    }

    /**
     * Checks if ALL descendants of a node are purely graphical shapes.
     * Returns false if any descendant is Text, an extracted component, or another
     * interactive container type (Button, ProgressBar, etc.).
     */
    private allDescendantsAreShapes(node: UINode): boolean {
        if (!node.children || node.children.length === 0) return true;

        for (const child of node.children) {
            // Text → cannot flatten
            if (child.type === ObjectType.Text || child.type === ObjectType.RichText || child.type === ObjectType.InputText) {
                return false;
            }
            // Interactive FGUI types → cannot flatten
            if (child.type === ObjectType.Button || child.type === ObjectType.Label ||
                child.type === ObjectType.ProgressBar || child.type === ObjectType.Slider ||
                child.type === ObjectType.ComboBox || child.type === ObjectType.List) {
                return false;
            }
            // Pure shape (Image = RECTANGLE/VECTOR/BOOLEAN_OPERATION/etc.) → OK
            // Even if asComponent=true, a shape is still a shape for SSR purposes
            if (child.type === ObjectType.Image || child.type === ObjectType.Graph) {
                continue;
            }
            // Extracted sub-component that is NOT a shape → cannot flatten
            if (child.asComponent) return false;
            // Container child → recurse
            if (!this.allDescendantsAreShapes(child)) return false;
        }
        return true;
    }

    /**
     * Recursively checks if any descendant (including invisible ones) has isMask: true.
     * Containers with mask descendants use Figma alpha masking / clipping effects
     * that can't be reproduced with individual FGUI elements — must be SSR-rendered as a whole.
     */
    private hasMaskDescendants(node: UINode): boolean {
        if (!node.children) return false;
        for (const child of node.children) {
            if (child.customProps?.isMask) return true;
            if (this.hasMaskDescendants(child)) return true;
        }
        return false;
    }

    /**
     * Recursively checks if a node has any Text descendants.
     * If it does, we should NOT flatten it to a single image.
     */
    private hasTextChildren(node: UINode): boolean {
        if (!node.children) return false;
        for (const child of node.children) {
            if (child.type === ObjectType.Text) return true;
            if (child.asComponent) continue; // Extracted components are independent
            if (this.hasTextChildren(child)) return true;
        }
        return false;
    }

    // --- Cache Management ---

    private async loadManifest(): Promise<CacheManifest | null> {
        try {
            if (await fs.pathExists(this.manifestPath)) {
                const data = await fs.readFile(this.manifestPath, 'utf-8');
                return JSON.parse(data) as CacheManifest;
            }
        } catch {
            console.warn('⚠️ ImagePipeline: Failed to load cache manifest, will re-download.');
        }
        return null;
    }

    private async saveManifest(processedItems: PipelineItem[]): Promise<void> {
        const existingFiles = this.manifest?.files || {};

        // Merge new entries
        for (const item of processedItems) {
            existingFiles[item.fileName] = { nodeId: item.sourceId };
        }

        const newManifest: CacheManifest = {
            figmaVersion: this.figmaVersion,
            lastModified: new Date().toISOString(),
            files: existingFiles,
        };

        await fs.writeFile(this.manifestPath, JSON.stringify(newManifest, null, 2));
    }

    // --- Download with Retry ---

    private async downloadWithRetry(url: string, destPath: string, label: string, retries = 3): Promise<void> {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                await this.client.downloadImage(url, destPath);
                return;
            } catch (err) {
                if (attempt === retries) {
                    console.error(`❌ ImagePipeline: Failed to download ${label} after ${retries} retries.`);
                } else {
                    const backoff = attempt * 500;
                    console.warn(`⚠️ ImagePipeline: Retry ${attempt}/${retries} for ${label} (waiting ${backoff}ms)...`);
                    await this.delay(backoff);
                }
            }
        }
    }

    // --- Utilities ---

    private chunk<T>(arr: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < arr.length; i += size) {
            chunks.push(arr.slice(i, i + size));
        }
        return chunks;
    }

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
