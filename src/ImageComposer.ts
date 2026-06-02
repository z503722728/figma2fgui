import * as path from 'path';
import * as fs from 'fs-extra';
import sharp from 'sharp';
import { UINode } from './models/UINode';
import { FGUI_SCALE } from './Common';

export interface ComposeTask {
    /** 合并后输出的文件名 */
    outputFileName: string;
    /** 合并后的资源 ID */
    outputResId: string;
    /** 各图层（按 z-order 从下到上），每层是已下载的 PNG 路径 */
    layers: Array<{
        filePath: string;
        /** 相对于基准节点的偏移（已乘 FGUI_SCALE） */
        offsetX: number;
        offsetY: number;
        width: number;
        height: number;
    }>;
    /** 裁剪到基准节点尺寸 */
    clip: boolean;
    clipWidth: number;
    clipHeight: number;
    /** 基准节点尺寸（合成画布大小） */
    canvasWidth: number;
    canvasHeight: number;
}

/**
 * ImageComposer：用 sharp 本地合成多图层为一张 PNG。
 *
 * 典型用途：弹窗背景（底色 + 遮罩层 + 纹理层）合并为一张图，
 * 避免在运行时多张图叠加渲染，也避免多次 Figma SSR 请求。
 *
 * 合并规则：
 *   - 各图层按传入顺序从下到上叠加（first = bottom）
 *   - clip=true 时裁剪到 clipWidth×clipHeight
 *   - 各图层可能尺寸超出裁剪框（如纹理图比底图大），sharp 会自然裁剪
 */
export class ImageComposer {
    private imgDir: string;

    constructor(imgDir: string) {
        this.imgDir = imgDir;
    }

    /**
     * 执行所有合成任务。
     * 只处理所有图层文件都已存在的任务（图片下载后调用）。
     */
    async compose(tasks: ComposeTask[]): Promise<void> {
        for (const task of tasks) {
            // 检查所有图层文件是否存在
            const allExist = task.layers.every(l => fs.existsSync(l.filePath));
            if (!allExist) {
                const missing = task.layers.filter(l => !fs.existsSync(l.filePath)).map(l => path.basename(l.filePath));
                console.warn(`⚠️ [ImageComposer] 跳过合成 "${task.outputFileName}"，缺少图层: ${missing.join(', ')}`);
                continue;
            }

            const outputPath = path.join(this.imgDir, task.outputFileName);
            if (fs.existsSync(outputPath)) {
                console.log(`✅ [ImageComposer] 已缓存: ${task.outputFileName}`);
                continue;
            }

            try {
                await this.composeTask(task, outputPath);
                console.log(`🖼️ [ImageComposer] 合成完成: ${task.outputFileName} (${task.canvasWidth}×${task.canvasHeight})`);
            } catch (err: any) {
                console.error(`❌ [ImageComposer] 合成失败 "${task.outputFileName}": ${err.message}`);
            }
        }
    }

    private async composeTask(task: ComposeTask, outputPath: string): Promise<void> {
        const { canvasWidth, canvasHeight, clip, clipWidth, clipHeight } = task;

        // 创建透明画布（足够大以容纳所有图层）
        let composite = sharp({
            create: {
                width:  canvasWidth,
                height: canvasHeight,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            }
        });

        // 叠加各图层
        const overlays = task.layers.map(layer => ({
            input: layer.filePath,
            left: Math.max(0, Math.round(layer.offsetX)),
            top:  Math.max(0, Math.round(layer.offsetY)),
        }));

        composite = composite.composite(overlays);

        // 裁剪
        if (clip) {
            composite = composite.extract({
                left:   0,
                top:    0,
                width:  Math.min(clipWidth,  canvasWidth),
                height: Math.min(clipHeight, canvasHeight)
            });
        }

        await composite.png().toFile(outputPath);
    }

    /**
     * 从 UINode 树中收集所有需要合并的任务。
     *
     * 遍历节点树，找到带 _mergeLayers 标记的节点，
     * 根据各图层的已下载文件路径和坐标差构建 ComposeTask。
     *
     * @param nodes      UINode 树
     * @param allNodes   nodeSourceId → UINode 的全局映射（用于查坐标）
     * @param imgResMap  sourceId → { filePath, resId, width, height } 映射
     */
    buildTasks(
        nodes: UINode[],
        allNodes: Map<string, UINode>,
        imgResMap: Map<string, { filePath: string; resId: string; width: number; height: number }>
    ): ComposeTask[] {
        const tasks: ComposeTask[] = [];

        const visit = (node: UINode) => {
            const ml = (node as any)._mergeLayers;
            if (ml) {
                const task = this.buildTaskFromNode(node, ml, allNodes, imgResMap);
                if (task) tasks.push(task);
            }
            node.children?.forEach(visit);
        };
        nodes.forEach(visit);

        return tasks;
    }

    private buildTaskFromNode(
        primaryNode: UINode,
        ml: { nodes: string[]; clip?: boolean; clip_to?: string },
        allNodes: Map<string, UINode>,
        imgResMap: Map<string, { filePath: string; resId: string; width: number; height: number }>
    ): ComposeTask | null {
        const { nodes: nodeIds, clip = true, clip_to } = ml;
        const clipNodeId = clip_to || nodeIds[0];
        const clipNode = allNodes.get(clipNodeId);

        if (!clipNode) {
            console.warn(`⚠️ [ImageComposer] clip_to 节点 "${clipNodeId}" 不存在，跳过`);
            return null;
        }

        // 基准节点的绝对坐标（用于计算其他图层的相对偏移）
        const baseX = clipNode.x * FGUI_SCALE;
        const baseY = clipNode.y * FGUI_SCALE;
        const clipW  = clipNode.width  * FGUI_SCALE;
        const clipH  = clipNode.height * FGUI_SCALE;

        // 计算画布大小（所有图层的最大范围）
        let canvasW = clipW;
        let canvasH = clipH;
        const layers: ComposeTask['layers'] = [];

        for (const nodeId of nodeIds) {
            const res = imgResMap.get(nodeId);
            if (!res) {
                console.warn(`⚠️ [ImageComposer] 节点 "${nodeId}" 没有对应图片，跳过该图层`);
                continue;
            }
            const layerNode = allNodes.get(nodeId);
            const layerX = layerNode ? (layerNode.x * FGUI_SCALE - baseX) : 0;
            const layerY = layerNode ? (layerNode.y * FGUI_SCALE - baseY) : 0;

            // 如果不裁剪，画布需要足够大
            if (!clip) {
                canvasW = Math.max(canvasW, layerX + res.width);
                canvasH = Math.max(canvasH, layerY + res.height);
            }

            layers.push({
                filePath: res.filePath,
                offsetX: layerX,
                offsetY: layerY,
                width:   res.width,
                height:  res.height,
            });
        }

        if (layers.length === 0) return null;

        // 输出文件名：用主节点名 + sourceId
        const primarySrc = primaryNode.sourceId || primaryNode.id;
        const shortId = primarySrc.replace(/[^a-zA-Z0-9]/g, '_');
        const outputFileName = `${primaryNode.name}_merged_${shortId}.png`;
        const outputResId    = `img_merged_${shortId}`;

        return {
            outputFileName,
            outputResId,
            layers,
            clip:        !!clip,
            clipWidth:   Math.round(clipW),
            clipHeight:  Math.round(clipH),
            canvasWidth:  Math.round(canvasW),
            canvasHeight: Math.round(canvasH),
        };
    }
}
