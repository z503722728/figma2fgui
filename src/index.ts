import * as fs from 'fs-extra';
import * as crypto from 'crypto';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { RawFigmaParser } from './RawFigmaParser';
import { XMLGenerator } from './generator/XMLGenerator';
import { SubComponentExtractor } from './generator/SubComponentExtractor';
import { FigmaClient } from './FigmaClient';
import { ImagePipeline } from './ImagePipeline';
import { ImageComposer } from './ImageComposer';
import { UINode, ResourceInfo } from './models/UINode';
import { sanitizeFileName, FGUI_SCALE } from './Common';
import { AISemanticTagger } from './tagger/AISemanticTagger';
import { loadProjectRules, isBackgroundNode } from './rules/RuleLoader';

dotenv.config();

export interface RunOptions {
    figmaToken:   string;
    figmaFileKey: string;
    figmaNodeId?: string;
    outputPath?:  string;
    forceDryRun?: boolean;
}

export async function run(opts: RunOptions): Promise<void> {
    const FIGMA_TOKEN    = opts.figmaToken;
    const FIGMA_FILE_KEY = opts.figmaFileKey;
    const FIGMA_NODE_ID  = opts.figmaNodeId;
    const OUTPUT_PATH    = opts.outputPath ?? process.env.OUTPUT_PATH;

    console.log(`🔑 FIGMA_TOKEN:   ${FIGMA_TOKEN   ? '已加载' : '缺失'}`);
    console.log(`📄 FIGMA_FILE_KEY: ${FIGMA_FILE_KEY || '缺失'}`);
    if (FIGMA_NODE_ID) console.log(`🎯 FIGMA_NODE_ID: ${FIGMA_NODE_ID}`);
    if (OUTPUT_PATH)   console.log(`📂 OUTPUT_PATH:   ${OUTPUT_PATH}`);

    // ─── 路径初始化 ──────────────────────────────────────────────────────────────
    const defaultOutputDir = path.join(__dirname, '../FGUIProject/assets');
    const finalOutputDir   = OUTPUT_PATH || defaultOutputDir;
    const nodeIdForPath = FIGMA_NODE_ID?.replace(/[:\-]/g, '_');
    const packName    = nodeIdForPath ? `Node_${nodeIdForPath}` : 'CloudPackage';
    const packagePath = path.join(finalOutputDir, packName);
    const imgDir      = path.join(packagePath, 'img');
    const debugJsonPath = path.join(packagePath, 'figma_debug.json');

    // ─── 动态规则加载（AI 生成的 project-rules.json，优先级高于 rules/*.json）──
    // 必须在所有规则查询之前调用
    loadProjectRules(packagePath);

    // ─── 0. 环境清理（保留图片缓存） ─────────────────────────────────────────────
    if (await fs.pathExists(packagePath)) {
        console.log(`🧹 清理旧 XML 文件（保留 img 缓存）...`);
        const files = await fs.readdir(packagePath);
        for (const file of files) {
            const fullPath = path.join(packagePath, file);
            const stat = await fs.stat(fullPath);
            if (!stat.isDirectory() && file.endsWith('.xml')) await fs.unlink(fullPath);
        }
    }

    // ─── 1. 获取 Figma 数据 ───────────────────────────────────────────────────────
    let figmaData: any;
    let figmaVersion = 'unknown';

    if (await fs.pathExists(debugJsonPath)) {
        console.log(`⚡ 发现本地调试缓存: ${debugJsonPath}，跳过 API 请求`);
        const jsonContent = await fs.readFile(debugJsonPath, 'utf-8');
        figmaData = JSON.parse(jsonContent);
        figmaVersion = figmaData.version || figmaData.lastModified || 'cached';
    }

    if (!figmaData && FIGMA_TOKEN && FIGMA_FILE_KEY) {
        const client = new FigmaClient(FIGMA_TOKEN, FIGMA_FILE_KEY);
        figmaData = FIGMA_NODE_ID
            ? await client.getNodes([FIGMA_NODE_ID])
            : await client.getFile();
        figmaVersion = figmaData.version || figmaData.lastModified || 'unknown';
        await fs.ensureDir(packagePath);
        await fs.writeFile(debugJsonPath, JSON.stringify(figmaData, null, 2));
        console.log(`🐛 原始 Figma 数据已保存至: ${debugJsonPath}`);
    } else if (!figmaData) {
        if (!FIGMA_FILE_KEY) {
            console.error("❌ 缺少 FIGMA_FILE_KEY，请在 .env 中配置，或通过 Figma URL 传入（推荐）：");
            console.error("   bun run convert \"https://www.figma.com/design/{fileKey}/...\"");
        } else {
            console.error("❌ 缺少本地缓存且缺少 Figma 凭据，请检查 .env 文件。");
        }
        process.exit(1);
    }

    // ─── 1.5 语义标注：读取 IDE AI 生成的 semantic_tags.json ──────────────────
    // semantic_tags.json 由 IDE AI 在分析阶段生成（`bun run analyze` 之后）
    // 不存在时直接走规则模式（project-rules.json 提供了动态关键词）
    const tagger = new AISemanticTagger();
    let handoffYaml = '';
    const topNodes = extractTopNodes(figmaData);

    const tagResult = await tagger.loadManualTags(packagePath);
    if (tagResult) {
        tagger.applyTags(topNodes, tagResult);
        handoffYaml = tagger.buildHandoffYaml(tagResult);
        console.log(`🏷️  语义标注已加载：${tagResult.tags.length} 个节点`);
    } else {
        console.log('📐 未找到 semantic_tags.json，使用 project-rules.json 规则模式');
    }

    // ─── 2. 解析 UINode 树 ────────────────────────────────────────────────────────
    const rawParser = new RawFigmaParser();
    let rootNodes: UINode[] = rawParser.parse(figmaData);
    console.log(`🌳 根节点数量: ${rootNodes.length}`);

    // ─── 3. 子组件提取 ────────────────────────────────────────────────────────────
    console.log("🧩 正在执行子组件提取...");
    const allResources: ResourceInfo[] = [];
    const client = new FigmaClient(FIGMA_TOKEN!, FIGMA_FILE_KEY!);
    const extractor = new SubComponentExtractor();
    const componentResources = extractor.extract(rootNodes);
    allResources.push(...componentResources);

    // ─── 4. ImagePipeline ────────────────────────────────────────────────────────
    console.log("🖼️ 扫描并入队图像资源...");
    const pipeline = new ImagePipeline(client, imgDir, figmaVersion);

    // 4a. 匹配已有 PNG
    let existingPngs: string[] = [];
    if (fs.existsSync(imgDir)) {
        existingPngs = fs.readdirSync(imgDir).filter(f => f.toLowerCase().endsWith('.png'));
        console.log(`🖼️ 发现 ${existingPngs.length} 个已缓存 PNG`);
    }

    const matchExistingPngs = (nodes: UINode[]) => {
        // 扩展组件类型：这些节点应走组件提取流程，不能被当成图片整体处理
        const EXTENSION_TYPES = new Set(['Button', 'Label', 'Slider', 'ProgressBar', 'ComboBox', 'List']);

        const primarySrcForMerge = new Map<string, string>(); // primary nodeId → resId

        const scanner = (node: UINode) => {
            if (node.visible === false) return;
            if (node.asComponent) { if (node.children) node.children.forEach(scanner); return; }

            // 💡 _mergedInto：此节点已合并到主节点，复用主节点的 src
            const mergedInto = (node as any)._mergedInto as string | undefined;
            if (mergedInto) {
                const primarySrc = primarySrcForMerge.get(mergedInto);
                if (primarySrc) {
                    node.src = primarySrc;
                    console.log(`🔗 匹配合并渲染: "${node.name}" → 复用 ${primarySrc}`);
                }
                // 无论是否找到主节点，都不再单独匹配
                return;
            }

            // 💡 有 AI 语义标注且是扩展类型 → 不做图片匹配，保留子节点让组件流程处理
            if ((node as any).semanticType && EXTENSION_TYPES.has((node as any).semanticType)) {
                if (node.children) node.children.forEach(scanner);
                return;
            }

            // 💡 AI 标注为 Component → 展开子节点，不整体匹配成图片
            // 例外：装饰性背景节点（水印/纹理）即使是 Component 也应整体匹配成图片
            const DECORATIVE_KEYWORDS = ['watermark', '纹理', 'texture', 'pattern', 'bg_watermark'];
            const isDecorative = DECORATIVE_KEYWORDS.some(k => node.name.toLowerCase().includes(k));
            if (!isDecorative && (node as any).semanticType === 'Component' && node.children?.length) {
                node.children.forEach(scanner);
                return;
            }

            const rawId = node.sourceId || node.id;
            const sanitizedId = rawId.replace(/:/g, '_');
            const strictSanitizedId = rawId.replace(/[:;]/g, '_');
            let foundPng: string | undefined;

            const exactName = `${sanitizeFileName(node.name)}_${sanitizedId}.png`;
            if (existingPngs.includes(exactName)) foundPng = exactName;
            if (!foundPng && node.name) {
                foundPng = existingPngs.find(f => {
                    const fName = f.toLowerCase();
                    return fName.endsWith(`_${sanitizedId.toLowerCase()}.png`) ||
                           fName.endsWith(`_${strictSanitizedId.toLowerCase()}.png`);
                });
            }

            if (foundPng) {
                console.log(`🖼️ 匹配已有 PNG: ${node.name} → ${foundPng}`);
                const res: ResourceInfo = {
                    id: 'img_' + sanitizedId, name: foundPng, type: 'image',
                    width: Math.round(node.width), height: Math.round(node.height),
                    _sourceId: rawId,  // 保留 sourceId 供 ImageComposer 使用
                };
                allResources.push(res);
                node.src = res.id;
                node.fileName = 'img/' + foundPng;
                node.children = [];
                // 记录主节点的 src，供 _mergedInto 节点复用
                if ((node as any)._mergedNodes?.length) {
                    primarySrcForMerge.set(node.sourceId || node.id, res.id);
                    console.log(`🔗 主节点已记录: "${node.name}" sourceId=${node.sourceId || node.id} → ${res.id}`);
                }
                return;
            }
            if (node.children) node.children.forEach(scanner);
        };
        nodes.forEach(scanner);
    };

    matchExistingPngs(rootNodes);

    // 4b. 处理提取的子组件
    const extractedNodesMap = new Map<string, UINode>();

    const justifyComponentLayout = (comp: UINode, res?: ResourceInfo) => {
        if (!comp.children || comp.children.length === 0) return;

        // 背景节点识别：
        // 优先匹配名称完全等于 "bg" 的节点（AI 标注的标准角色名）
        // 其次匹配 rules/exclude-names.json backgroundDetection 关键词
        // 但要求面积最大且名称不含其他语义前缀（排除 bg_glow、bg_mask 等修饰词）
        let bgNode: UINode | undefined;
        let maxArea = 0;
        comp.children.forEach(c => {
            const nameLow = c.name.toLowerCase();
            // 精确匹配 "bg" 或以 "bg_" 开头但不是 bg_glow/bg_mask/bg_watermark 等装饰词
            const isExactBg = nameLow === 'bg';
            const isDecoName = ['bg_glow', 'bg_mask', 'bg_watermark', 'bg_gradient', 'bg_decoration'].includes(nameLow);
            const isBgLike = !isDecoName && isBackgroundNode(c.name);
            if (isExactBg || isBgLike) {
                const area = c.width * c.height;
                if (!bgNode || area > maxArea) { bgNode = c; maxArea = area; }
            }
        });

        if (bgNode) {
            console.log(`📏 Justifying ${comp.name} based on background: ${bgNode.name}`);
            const offsetX = -bgNode.x;
            const offsetY = -bgNode.y;
            if (offsetX !== 0 || offsetY !== 0) {
                comp.children.forEach(c => { c.x += offsetX; c.y += offsetY; });
            }
            comp.width  = bgNode.width;
            comp.height = bgNode.height;

            comp.children.forEach(c => {
                if (c.visible === false) return;
                const overlapX = Math.min(c.x + c.width, comp.width)  - Math.max(c.x, 0);
                const overlapY = Math.min(c.y + c.height, comp.height) - Math.max(c.y, 0);
                if (overlapX <= 0 || overlapY <= 0) {
                    console.warn(`⚠️ "${c.name}" 超出组件边界: xy=(${c.x},${c.y}) size=(${c.width}x${c.height}) in ${comp.width}x${comp.height}`);
                }
            });
        } else {
            // Check/Radio Button（Toggle）：grip 圆形故意溢出轨道，不做负坐标归正，
            // 保持 Figma 原始相对坐标，只确保组件尺寸不小于本体节点。
            if (comp.extention === 'Button' && (comp.buttonMode === 'Check' || comp.buttonMode === 'Radio')) {
                // 不移动子节点，尺寸保持原始
            } else {
                let minX = 0, minY = 0, maxX = comp.width, maxY = comp.height;
                let hasNegative = false;
                comp.children.forEach(c => {
                    if (c.x < minX) { minX = c.x; hasNegative = true; }
                    if (c.y < minY) { minY = c.y; hasNegative = true; }
                    if (c.x + c.width  > maxX) maxX = c.x + c.width;
                    if (c.y + c.height > maxY) maxY = c.y + c.height;
                });
                if (hasNegative) {
                    const offsetX = minX < 0 ? -minX : 0;
                    const offsetY = minY < 0 ? -minY : 0;
                    console.log(`📏 Normalizing ${comp.name}: shift (${offsetX}, ${offsetY})`);
                    comp.children.forEach(c => { c.x += offsetX; c.y += offsetY; });
                    comp.width  = Math.max(comp.width,  maxX + offsetX);
                    comp.height = Math.max(comp.height, maxY + offsetY);
                }
            }
        }

        if (res) { res.width = comp.width; res.height = comp.height; }
    };

    componentResources.forEach(res => {
        if (res.type === 'component' && res.data) {
            try {
                const compRootFn = JSON.parse(res.data) as UINode;
                extractedNodesMap.set(res.id, compRootFn);
                const isPureShape = pipeline.isAtomicVisual(compRootFn);
                // 💡 扩展类型（Button/Label/Slider 等）即使全是形状也需要扫描子节点，
                // 让 bar/grip 等子节点各自下载图片，不能整体跳过。
                const isExtensionComp = [
                    'Button', 'Label', 'Slider', 'ProgressBar', 'ComboBox', 'List'
                ].includes(compRootFn.extention ?? '');

                // 💡 List item template：整体 SSR 成一张图（含圆角背景 + 图片遮罩）
                const isListItem = !!(compRootFn as any)._isListItem;

                if (!isPureShape || isExtensionComp) {
                    matchExistingPngs([compRootFn]);
                    pipeline.scanAndEnqueue([compRootFn], allResources);
                } else if (isListItem) {
                    // List item template：直接把整个节点作为一张图入队
                    (compRootFn as any)._mergeWithParent = true;
                    matchExistingPngs([compRootFn]);
                    pipeline.scanAndEnqueue([compRootFn], allResources);
                } else {
                    console.log(`⏭️ 跳过纯形状组件: ${res.name}`);
                }
                justifyComponentLayout(compRootFn, res);
                res.data = JSON.stringify(compRootFn);
            } catch (e) { console.warn(`⚠️ 解析组件失败: ${res.name}`, e); }
        }
    });

    pipeline.scanAndEnqueue(rootNodes, allResources);
    rootNodes.forEach(root => justifyComponentLayout(root));
    await fs.ensureDir(imgDir);

    // ─── 5. 下载图片 ──────────────────────────────────────────────────────────────
    await pipeline.execute();

    // ─── 5.5 本地多图合成（merge_layers） ───────────────────────────────────────
    // 遍历节点树，找到带 _mergeLayers 的节点，用 sharp 将各图层合成一张图。
    // 合成完成后更新节点的 src/fileName，使 XML 引用合成图而不是原始各层图。
    {
        const composer = new ImageComposer(imgDir);

        // 构建 sourceId → UINode 全局映射（包含已提取的组件节点）
        const allNodesMap = new Map<string, UINode>();
        const collectNodes = (node: UINode) => {
            if (node.sourceId) allNodesMap.set(node.sourceId, node);
            allNodesMap.set(node.id, node);
            node.children?.forEach(collectNodes);
        };
        rootNodes.forEach(collectNodes);
        // 同时收集已提取的组件节点（它们在 rootNodes 里已被 asComponent 引用替换）
        extractedNodesMap.forEach(node => collectNodes(node));

        // 构建 sourceId → { filePath, resId, width, height } 映射（来自已下载图片）
        const imgResMap = new Map<string, { filePath: string; resId: string; width: number; height: number }>();
        for (const res of allResources) {
            if (res.type === 'image' && res.name && res._sourceId) {
                imgResMap.set(res._sourceId, {
                    filePath: path.join(imgDir, res.name),
                    resId:    res.id,
                    width:    res.width || 0,
                    height:   res.height || 0,
                });
            }
        }

        // 同时收集 root nodes 和提取的组件节点里的 merge_layers 任务
        const allNodesToScan: UINode[] = [...rootNodes];
        for (const res of componentResources) {
            if (res.type === 'component' && res.data) {
                try { allNodesToScan.push(JSON.parse(res.data) as UINode); } catch {}
            }
        }

        const composeTasks = composer.buildTasks(allNodesToScan, allNodesMap, imgResMap);

        if (composeTasks.length > 0) {
            console.log(`🎨 [ImageComposer] 开始合成 ${composeTasks.length} 张合并图...`);
            await composer.compose(composeTasks);

            // 更新节点 src/fileName，使 XML 引用合成图
            const updateMergedSrc = (node: UINode) => {
                const ml = (node as any)._mergeLayers;
                if (ml) {
                    const task = composeTasks.find(t => {
                        // 匹配主节点：task 的 outputResId 包含主节点 sourceId
                        const sid = (node.sourceId || node.id).replace(/[^a-zA-Z0-9]/g, '_');
                        return t.outputResId.includes(sid);
                    });
                    if (task) {
                        // 检查合成文件是否存在
                        const composedPath = path.join(imgDir, task.outputFileName);
                        if (fs.existsSync(composedPath)) {
                            // 注册合成图到 allResources
                            const existing = allResources.find(r => r.id === task.outputResId);
                            if (!existing) {
                                allResources.push({
                                    id:     task.outputResId,
                                    name:   task.outputFileName,
                                    type:   'image',
                                    width:  task.clipWidth,
                                    height: task.clipHeight,
                                });
                            }
                            // 更新节点引用
                            node.src      = task.outputResId;
                            node.fileName = 'img/' + task.outputFileName;
                            node.children = []; // 清空原始子节点
                            console.log(`✅ [ImageComposer] "${node.name}" → ${task.outputFileName}`);
                        }
                    }
                }

                // _mergedInto 节点：标记为不可见（父节点已包含其内容）
                if ((node as any)._mergedInto) {
                    node.visible = false;
                }

                node.children?.forEach(updateMergedSrc);
            };
            rootNodes.forEach(updateMergedSrc);
            // 同时更新已提取的组件节点（它们不在 rootNodes 里）
            extractedNodesMap.forEach(node => updateMergedSrc(node));
            // 更新后的组件节点重新序列化
            extractedNodesMap.forEach((node, resId) => {
                const res = componentResources.find(r => r.id === resId);
                if (res) res.data = JSON.stringify(node);
            });
        }
    }
    // Package ID: prefix + MD5(nodeId)[0:length]，来自 pipeline-config.json
    const idSeed = FIGMA_NODE_ID || 'CloudPackage';
    const cfg = (() => { try { return Rules.pipeline().packageId; } catch { return { prefix: 'd2f', length: 5 }; } })();
    const buildId = cfg.prefix + crypto.createHash('md5').update(idSeed).digest('hex').substring(0, cfg.length);
    console.log(`🆔 Package ID: ${buildId}`);

    await fs.ensureDir(packagePath);
    const generator = new XMLGenerator();
    const validResources: ResourceInfo[] = [];
    const processedNames = new Map<string, number>();

    for (const res of componentResources) {
        if (res.type === 'component' && res.data) {
            const compNode = extractedNodesMap.get(res.id) || JSON.parse(res.data) as UINode;
            const hasVisuals = compNode.styles.fillType || compNode.styles.strokeSize;
            const isListItemTemplate = !!(compNode as any)._isListItem;
            // List item template 即使子节点清空也需要生成 XML（有图片 src）
            if (!compNode.children?.length && !hasVisuals && !compNode.listItemTemplate && !isListItemTemplate && !compNode.src) continue;

            let safeName = sanitizeFileName(res.name);
            if (processedNames.has(safeName)) {
                const count = processedNames.get(safeName)!;
                processedNames.set(safeName, count + 1);
                safeName = `${safeName}_${count}`;
            } else {
                processedNames.set(safeName, 1);
            }

            const xmlContent = generator.generateComponentXml(
                compNode.children || [], buildId,
                compNode.width, compNode.height,
                compNode.styles, compNode.extention, compNode.controllers,
                compNode.buttonMode, compNode.listItemTemplate
            );
            await fs.writeFile(path.join(packagePath, safeName + '.xml'), xmlContent);
            res.name = safeName;
            res.width  = Math.round(compNode.width  * FGUI_SCALE);
            res.height = Math.round(compNode.height * FGUI_SCALE);
            validResources.push(res);
        }
    }

    for (const node of rootNodes) {
        if (!node.children?.length && !node.styles.fillType) continue;
        extractor.applyStandardNaming(node);
        const safeName = sanitizeFileName(node.name);
        const xmlContent = generator.generateComponentXml(
            node.children || [], buildId,
            node.width, node.height,
            node.styles, undefined, node.controllers,
            node.buttonMode
        );
        await fs.writeFile(path.join(packagePath, `${safeName}.xml`), xmlContent);
        if (!processedNames.has(safeName)) {
            validResources.push({
                id: `main_${node.id.replace(/:/g, '_')}`, name: `${safeName}.xml`,
                type: 'component', exported: true,
                width:  Math.round(node.width  * FGUI_SCALE),
                height: Math.round(node.height * FGUI_SCALE)
            });
            processedNames.set(safeName, 1);
        }
    }

    const seenImageIds = new Set<string>();
    const uniqueImages = allResources.filter(r => {
        if (r.type !== 'image') return false;
        if (seenImageIds.has(r.id)) return false;
        seenImageIds.add(r.id); return true;
    });
    const finalResources = [...validResources, ...uniqueImages];
    const packageXml = generator.generatePackageXml(finalResources, buildId, packName);
    await fs.writeFile(path.join(packagePath, 'package.xml'), packageXml);

    // ─── 7. 输出回收 YAML ──────────────────────────────────────────────────────────
    if (handoffYaml) {
        const yamlPath = path.join(packagePath, 'handoff.yaml');
        await fs.writeFile(yamlPath, handoffYaml);
        console.log(`📋 AI 决策回收 YAML 已写入: ${yamlPath}`);
    }

    console.log(`\n🎉 成功！FGUI 包已生成至: ${packagePath}`);
}

/**
 * 从 figmaData 提取顶层节点，供 AISemanticTagger 分析。
 * 不做解析，只取原始 Figma 节点对象。
 */
function extractTopNodes(figmaData: any): any[] {
    const nodes: any[] = [];
    if (figmaData.document) {
        figmaData.document.children.forEach((page: any) => {
            page.children.forEach((node: any) => {
                if (node.type === 'FRAME' || node.type === 'INSTANCE' || node.type === 'COMPONENT') {
                    nodes.push(node);
                }
            });
        });
    } else if (figmaData.nodes) {
        Object.values(figmaData.nodes).forEach((nd: any) => {
            if (nd?.document) nodes.push(nd.document);
        });
    }
    return nodes;
}

// ─── .env 模式入口（直接 bun run src/index.ts） ────────────────────────────
// 仅当此文件被直接运行时才触发，import 时不执行
async function main() {
    const token = process.env.FIGMA_TOKEN;
    if (!token) {
        console.error('❌ FIGMA_TOKEN 未配置，请在 .env 中填写');
        process.exit(1);
    }
    await run({
        figmaToken:   token,
        figmaFileKey: process.env.FIGMA_FILE_KEY ?? '',
        figmaNodeId:  process.env.FIGMA_NODE_ID,
        outputPath:   process.env.OUTPUT_PATH,
    });
}

if (import.meta.main) {
    main().catch(err => {
        console.error("💥 Critical Error:", err);
        process.exit(1);
    });
}
