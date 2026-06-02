import * as fs from 'fs-extra';
import * as crypto from 'crypto';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { RawFigmaParser } from './RawFigmaParser';
import { XMLGenerator } from './generator/XMLGenerator';
import { SubComponentExtractor } from './generator/SubComponentExtractor';
import { FigmaClient } from './FigmaClient';
import { ImagePipeline } from './ImagePipeline';
import { UINode, ResourceInfo } from './models/UINode';
import { sanitizeFileName, FGUI_SCALE } from './Common';
import { AISemanticTagger } from './tagger/AISemanticTagger';
import { Rules, isBackgroundNode } from './rules/RuleLoader';

dotenv.config();

async function main() {
    const FIGMA_TOKEN   = process.env.FIGMA_TOKEN;
    const FIGMA_FILE_KEY = process.env.FIGMA_FILE_KEY;
    const FIGMA_NODE_ID  = process.env.FIGMA_NODE_ID;
    const OUTPUT_PATH    = process.env.OUTPUT_PATH;

    console.log(`🔑 FIGMA_TOKEN:   ${FIGMA_TOKEN  ? '已加载' : '缺失'}`);
    console.log(`📄 FIGMA_FILE_KEY: ${FIGMA_FILE_KEY || '缺失'}`);
    if (FIGMA_NODE_ID) console.log(`🎯 FIGMA_NODE_ID: ${FIGMA_NODE_ID}`);
    if (OUTPUT_PATH)   console.log(`📂 OUTPUT_PATH:   ${OUTPUT_PATH}`);

    // ─── 路径初始化 ──────────────────────────────────────────────────────────────
    const defaultOutputDir = path.join(__dirname, '../FGUIProject/assets');
    const finalOutputDir   = OUTPUT_PATH || defaultOutputDir;
    const packName    = FIGMA_NODE_ID ? `Node_${FIGMA_NODE_ID.replace(':', '_')}` : 'CloudPackage';
    const packagePath = path.join(finalOutputDir, packName);
    const imgDir      = path.join(packagePath, 'img');
    const debugJsonPath = path.join(packagePath, 'figma_debug.json');

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
        console.error("❌ 缺少本地缓存且缺少 Figma 凭据，请检查 .env 文件。");
        process.exit(1);
    }

    // ─── 1.5 AI 语义标注（可选预处理层） ─────────────────────────────────────────
    // 在 RawFigmaParser 解析前，对原始 Figma 节点树注入语义标签。
    // AI 失败时静默降级，不中断流程。
    const tagger = new AISemanticTagger();
    let handoffYaml = '';

    if (tagger.isAvailable) {
        // 收集顶层节点供 AI 分析
        const topNodes = extractTopNodes(figmaData);
        const tagResult = await tagger.tag(topNodes);
        if (tagResult) {
            tagger.applyTags(topNodes, tagResult);
            handoffYaml = tagger.buildHandoffYaml(tagResult);
            console.log(`🤖 AI 标注完成，共 ${tagResult.tags.length} 个节点`);
        }
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
        const scanner = (node: UINode) => {
            if (node.visible === false) return;
            if (node.asComponent) { if (node.children) node.children.forEach(scanner); return; }

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
                    width: Math.round(node.width), height: Math.round(node.height)
                };
                allResources.push(res);
                node.src = res.id;
                node.fileName = 'img/' + foundPng;
                node.children = [];
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

        // 背景节点识别从 rules/exclude-names.json 读取（isBackgroundNode）
        let bgNode: UINode | undefined;
        let maxArea = 0;
        comp.children.forEach(c => {
            if (isBackgroundNode(c.name)) {
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

        if (res) { res.width = comp.width; res.height = comp.height; }
    };

    componentResources.forEach(res => {
        if (res.type === 'component' && res.data) {
            try {
                const compRootFn = JSON.parse(res.data) as UINode;
                extractedNodesMap.set(res.id, compRootFn);
                const isPureShape = pipeline.isAtomicVisual(compRootFn);
                if (!isPureShape) {
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

    // ─── 6. 生成 XML ──────────────────────────────────────────────────────────────
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
            if (!compNode.children?.length && !hasVisuals) continue;

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
                compNode.styles, compNode.extention, compNode.controllers
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
            node.styles, undefined, node.controllers
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

main().catch(err => {
    console.error("💥 Critical Error:", err);
    process.exit(1);
});
