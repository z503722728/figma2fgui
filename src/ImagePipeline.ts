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
 * Figma nodeId → 短唯一后缀。
 *
 * Figma 的 INSTANCE 节点 ID 格式通常为：
 *   "I112:5767;112:5742;112:5736"（多层嵌套，以 ";" 分隔）
 *   "1339:6417"（普通节点，以 ":" 分隔）
 *
 * 策略：取最后两段（";" 分隔），各自把 ":" 替换为 "_"，用 "-" 连接。
 * 两段足以在同一文件中区分所有同名节点，同时保持可读性。
 *
 * 示例：
 *   "I1339:6417;39:279;166:1909;26:1538" → "166_1909-26_1538"
 *   "I112:5767;112:5742"                → "112_5767-112_5742"
 *   "1339:6409"                         → "1339_6409"
 */
function buildShortId(sourceId: string): string {
    const raw = sourceId.startsWith('I') ? sourceId.slice(1) : sourceId;
    const segments = raw.split(';');
    // 取最后两段，不足两段则取全部
    const tail = segments.slice(-2);
    return tail
        .map(s => s.replace(/:/g, '_').replace(/[^a-zA-Z0-9_]/g, ''))
        .join('-');
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

        // ─── 语义化文件名 ──────────────────────────────────────────────────────
        // 规则：{语义名}_{短ID}{suffix}.png
        //   语义名  = sanitize(node.name)，最多 24 字符
        //   短ID    = sourceId 最后一个 ";" 后的部分（如 "22_351"），保证唯一性
        //             若无 ";" 则取 ":" 分隔的最后两段（如 "112_5566"）
        // 示例：bg_I1339:6417;39:279;166:1909;26:1538 → bg_26_1538.png
        //        icon_cash_I1339:6409;7:61;172:2273  → icon_cash_172_2273.png
        const semanticName = sanitizeFileName(node.name).substring(0, 24);
        const shortId = buildShortId(sourceId);
        const fileName = `${semanticName}_${shortId}${suffix}.png`;
        const resId    = `img_${semanticName}_${shortId}${suffix.replace(/[^a-zA-Z0-9]/g, '_')}`;

        this.queue.push({ node, sourceId, fileName, resId, suffix });

        const padding = getVisualPadding(node);
        return {
            id: resId,
            name: fileName,
            type: 'image',
            width:  Math.round((node.width  + padding * 2) * FGUI_SCALE),
            height: Math.round((node.height + padding * 2) * FGUI_SCALE),
            _sourceId: sourceId,  // 保留原始 sourceId 供 ImageComposer 使用
        };
    }

    public isAtomicVisual(node: UINode): boolean {
        if (node.type === ObjectType.Image) return true;
        return node.children != null && node.children.length > 0 && this.allDescendantsAreShapes(node);
    }

    public scanAndEnqueue(nodes: UINode[], allResources: ResourceInfo[]): void {
        // 先收集所有主节点（_mergedInto 的目标）的 src，用于后续复用
        const primarySrcMap = new Map<string, string>(); // mergedInto nodeId → primary src

        const visit = (node: UINode) => {
            if (node.visible === false) return;
            if (node.src) {
                if (node.multiLooks) this.enqueueMultiLooks(node, node.src, allResources);
                // 如果这个节点是主节点，记录它的 src 供被合并节点复用
                if ((node as any)._mergedNodes?.length) {
                    primarySrcMap.set(node.sourceId || node.id, node.src);
                }
                return;
            }
            if (node.asComponent) {
                if (node.children) node.children.forEach(visit);
                return;
            }

            // _mergedInto：此节点已被标注为合并到父节点，不单独下载/渲染
            const mergedInto = (node as any)._mergedInto as string | undefined;
            if (mergedInto) return;

            // _mergeWithParent: 节点本身连同其所有子节点整体作为一张图 SSR（如 grip=圆+图标）
            const isLeaf = (node as any)._mergeWithParent || this.isVisualLeaf(node);
            if (isLeaf) {
                const res = this.enqueue(node);
                allResources.push(res);
                node.src = res.id;
                node.fileName = 'img/' + res.name;
                if (node.multiLooks) this.enqueueMultiLooks(node, res.id, allResources);
                // 合并节点：子节点不再单独扫描，清空以防 XMLGenerator 展开
                if ((node as any)._mergeWithParent && node.children?.length) {
                    node.children = [];
                }
                // 记录主节点的 src，供被合并节点复用
                if ((node as any)._mergedNodes?.length) {
                    primarySrcMap.set(node.sourceId || node.id, res.id);
                }
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
                const onResId  = pageIds.map(p => lookResMap[p]).find(r => r && r !== baseResId) || baseResId;
                const offResId = baseResId;
                if (onResId !== offResId) {
                    // Check Button（off/on 两态）：4页布局 → up=off, down=on, over=off, selectedOver=on
                    gear.values = [offResId, onResId, offResId, onResId].join('|');
                } else {
                    // 普通 Button（只有 hover/press 效果，off=on 同图）
                    gear.values = [baseResId, baseResId, baseResId, baseResId].join('|');
                }
            } else {
                // 其他 controller：按实际 pageId 范围生成
                const maxPage = Math.max(...pageIds);
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

        // ─── 情况 A 去重：相同 fileName 不同 sourceId ────────────────────────────
        // Figma INSTANCE 的多个实例共享同一个组件库节点，SSR 渲染内容完全相同。
        // 只请求第一个 sourceId，下载后把文件复制给其余碰撞项，节省 API 配额和带宽。
        const uniqueByFileName = new Map<string, PipelineItem>(); // fileName → 代表项
        const aliasMap = new Map<string, string[]>();             // fileName → 其余碰撞项的 fileName（此处相同，记 sourceId 备用）
        const collisionGroups = new Map<string, PipelineItem[]>(); // fileName → 所有碰撞项

        for (const item of itemsToProcess) {
            if (!uniqueByFileName.has(item.fileName)) {
                uniqueByFileName.set(item.fileName, item);
                collisionGroups.set(item.fileName, [item]);
            } else {
                collisionGroups.get(item.fileName)!.push(item);
            }
        }

        const deduped = Array.from(uniqueByFileName.values());
        const savedRequests = itemsToProcess.length - deduped.length;
        if (savedRequests > 0) {
            console.log(`🔁 ImagePipeline: 去重后 ${deduped.length} 个唯一请求（节省 ${savedRequests} 次重复下载）`);
        }

        const urlMap = new Map<string, string>();
        const batches = this.chunk(deduped, this.BATCH_SIZE);
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

        const downloadTasks = deduped
            .filter(item => urlMap.has(item.sourceId))
            .map(item => () => this.downloadWithRetry(
                urlMap.get(item.sourceId)!,
                path.join(this.imgDir, item.fileName),
                item.fileName
            ));

        const missing = deduped.filter(item => !urlMap.has(item.sourceId));
        if (missing.length > 0) {
            console.warn(`⚠️ ImagePipeline: ${missing.length} nodes returned no URL.`);
            missing.forEach(item => console.warn(`   - ${item.fileName} (${item.sourceId})`));
        }

        console.log(`⬇️ ImagePipeline: Downloading ${downloadTasks.length} images (concurrency=${this.CONCURRENCY})...`);
        await parallelLimit(downloadTasks, this.CONCURRENCY);
        await this.saveManifest(itemsToProcess); // 仍用原始完整列表写 manifest，保证缓存命中
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

        // 💡 装饰性背景节点（水印/纹理）即使含文字也应整体 SSR
        // 判断依据：节点名称含 watermark/纹理/texture 等关键词
        const DECORATIVE_KEYWORDS = ['watermark', '纹理', 'texture', 'pattern', 'bg_watermark'];
        const nameLow = node.name.toLowerCase();
        const isDecorative = DECORATIVE_KEYWORDS.some(k => nameLow.includes(k));

        const hasVisualProps = !!(
            node.styles?.fillColor || node.styles?.strokeColor ||
            node.styles?.imageFill || (node.styles?.filters && node.styles.filters.length > 0)
        );
        const hasFillPaths = Array.isArray(node.customProps?.fillGeometry) && node.customProps.fillGeometry.length > 0;

        if ((hasVisualProps || hasFillPaths) && (!this.hasTextChildren(node) || isDecorative)) return true;

        if (node.children && node.children.length > 0 && this.allDescendantsAreShapes(node)) {
            // 💡 AI 语义标注为 Slider 的节点即使全为形状也不 SSR（Toggle 开关组件）
            if ((node as any).semanticType === 'Slider') {
                return false;
            }
            console.log(`🧩 isVisualLeaf: Treating "${node.name}" as atomic unit (all children are shapes)`);
            return true;
        }

        // 💡 含文字且是装饰性节点（全文字内容的水印层）→ 整体 SSR
        if (isDecorative && node.children?.length) {
            console.log(`🖼️ isVisualLeaf: Decorative node "${node.name}" → force SSR`);
            return true;
        }

        // 💡 含 mask 的节点：
        // - asComponent=true（提取的子组件）→ 不 SSR，让子节点各自处理
        // - AI 标注了 semanticType（Component/Label 等）→ 不 SSR，尊重 AI 判断
        // - 其余 → 整体 SSR 保留 mask 效果
        const hasSemanticTag = !!(node as any).semanticType;
        if (node.children && node.children.length > 0
            && !node.asComponent && !hasSemanticTag
            && this.hasMaskDescendants(node)) {
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
