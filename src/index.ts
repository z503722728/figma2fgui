import * as fs from 'fs-extra';
import * as crypto from 'crypto';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { RawFigmaParser } from './RawFigmaParser';
import { XMLGenerator } from './generator/XMLGenerator';
import { FlexLayoutCalculator } from './FlexLayoutCalculator';
import { SubComponentExtractor } from './generator/SubComponentExtractor';
import { FigmaClient } from './FigmaClient';
import { ImagePipeline } from './ImagePipeline';
import { UINode, ResourceInfo } from './models/UINode';
import { ObjectType } from './models/FGUIEnum';
import { sanitizeFileName } from './Common';

dotenv.config();

async function main() {
    const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
    const FIGMA_FILE_KEY = process.env.FIGMA_FILE_KEY;
    const FIGMA_NODE_ID = process.env.FIGMA_NODE_ID;
    const OUTPUT_PATH = process.env.OUTPUT_PATH;

    console.log(`🔑 FIGMA_TOKEN: ${FIGMA_TOKEN ? '已加载' : '缺失'}`);
    console.log(`📄 FIGMA_FILE_KEY: ${FIGMA_FILE_KEY || '缺失'}`);
    if (FIGMA_NODE_ID) console.log(`🎯 FIGMA_NODE_ID: ${FIGMA_NODE_ID}`);
    if (OUTPUT_PATH) console.log(`📂 OUTPUT_PATH: ${OUTPUT_PATH}`);

    const defaultOutputDir = path.join(__dirname, '../FGUIProject/assets');
    const finalOutputDir = OUTPUT_PATH || defaultOutputDir;
    const packName = FIGMA_NODE_ID ? `Node_${FIGMA_NODE_ID.replace(':', '_')}` : 'CloudPackage';
    const packagePath = path.join(finalOutputDir, packName);
    const imgDir = path.join(packagePath, 'img');

    // 💡 确保 debug json 路径跟随 packagePath
    const debugJsonPath = path.join(packagePath, 'figma_debug.json');

    // --- 0. 环境清理 (保留图片缓存) ---
    if (await fs.pathExists(packagePath)) {
        console.log(`🧹 检测到现有目录，正在清理旧 XML 文件 (保留 img 缓存)...`);
        const files = await fs.readdir(packagePath);
        for (const file of files) {
            const fullPath = path.join(packagePath, file);
            const stat = await fs.stat(fullPath);
            if (!stat.isDirectory() && file.endsWith('.xml')) {
                await fs.unlink(fullPath);
            }
        }
    }

    let rootNodes: UINode[] = [];
    let figmaData: any;
    let figmaVersion = 'unknown';

    // --- 1. 获取数据阶段 ---
    if (await fs.pathExists(debugJsonPath)) {
        console.log(`🚀 发现本地调试缓存: ${debugJsonPath}`);
        console.log(`⚡ 跳过 API 请求，直接使用本地数据...`);
        const jsonContent = await fs.readFile(debugJsonPath, 'utf-8');
        figmaData = JSON.parse(jsonContent);
        // Extract version from cached data if available
        figmaVersion = figmaData.version || figmaData.lastModified || 'cached';
    } 
    
    if (!figmaData && FIGMA_TOKEN && FIGMA_FILE_KEY) {
        const client = new FigmaClient(FIGMA_TOKEN, FIGMA_FILE_KEY);
        
        if (FIGMA_NODE_ID) {
            figmaData = await client.getNodes([FIGMA_NODE_ID]);
        } else {
            figmaData = await client.getFile();
        }

        // Extract version for caching
        figmaVersion = figmaData.version || figmaData.lastModified || 'unknown';

        await fs.ensureDir(packagePath);
        await fs.writeFile(debugJsonPath, JSON.stringify(figmaData, null, 2));
        console.log(`🐛 原始 Figma 数据已保存至: ${debugJsonPath}`);
    } else if (!figmaData) {
        console.error("❌ 缺少本地缓存且缺少 Figma 凭据，无法获取数据。请检查 .env 文件。");
        process.exit(1);
    }

    const rawParser = new RawFigmaParser();
    rootNodes = rawParser.parse(figmaData);
    console.log(`🌳 Initial root nodes: ${rootNodes.length}`);

    // --- 2. 布局计算 ---
    const calculator = new FlexLayoutCalculator();
    calculator.calculate(rootNodes);

    // --- 3. 组件提取 ---
    console.log("🧩 正在执行智能组件提取...");
    const allResources: ResourceInfo[] = [];
    const client = new FigmaClient(FIGMA_TOKEN!, FIGMA_FILE_KEY!);

    const extractor = new SubComponentExtractor();
    const componentResources = extractor.extract(rootNodes);
    allResources.push(...componentResources);

    // --- 4. ImagePipeline: 统一的图像获取 ---
    console.log("🖼️ 正在扫描并入队图像资源...");
    const pipeline = new ImagePipeline(client, imgDir, figmaVersion);

    // 4a. Pre-scan img directory for existing PNGs (manual match)
    let existingPngs: string[] = [];
    if (fs.existsSync(imgDir)) {
        existingPngs = fs.readdirSync(imgDir).filter(f => f.toLowerCase().endsWith('.png'));
        console.log(`🖼️ Found ${existingPngs.length} existing PNGs in cache.`);
    }

    // 4b. Match existing PNGs to nodes (preserves manual PNG matching logic)
    const matchExistingPngs = (nodes: UINode[]) => {
        const scanner = (node: UINode) => {
            if (node.visible === false) return;
            
            const rawId = node.sourceId || node.id;
            const sanitizedId = rawId.replace(/:/g, '_');
            const strictSanitizedId = rawId.replace(/[:;]/g, '_');

            let foundPng: string | undefined;

            // 1. Direct match
            const exactName = `${sanitizeFileName(node.name)}_${sanitizedId}.png`;
            if (existingPngs.includes(exactName)) foundPng = exactName;

            // 2. Suffix match
            if (!foundPng && node.name) {
                foundPng = existingPngs.find(f => {
                    const fName = f.toLowerCase();
                    return fName.endsWith(`_${sanitizedId.toLowerCase()}.png`) ||
                        fName.endsWith(`_${strictSanitizedId.toLowerCase()}.png`);
                });
            }

            if (foundPng) {
                console.log(`🖼️ Matched existing PNG for ${node.name}: ${foundPng}`);
                const res: ResourceInfo = {
                    id: 'img_' + sanitizedId,
                    name: foundPng,
                    type: 'image',
                    width: Math.round(node.width),
                    height: Math.round(node.height)
                };
                allResources.push(res);
                node.src = res.id;
                node.fileName = 'img/' + foundPng;
                node.children = []; // Treat as leaf
                return;
            }

            if (node.children) node.children.forEach(scanner);
        };
        nodes.forEach(scanner);
    };

    // Match existing PNGs first (before pipeline scan)
    matchExistingPngs(rootNodes);

    // 4c. Scan extracted components
    const extractedNodesMap = new Map<string, UINode>();
    
    const justifyComponentLayout = (comp: UINode, res?: ResourceInfo) => {
        if (!comp.children || comp.children.length === 0) return;

        // Identify "Background" Node
        let bgNode: UINode | undefined;
        let maxArea = 0;

        comp.children.forEach(c => {
            const nameLow = c.name.toLowerCase();
            const area = c.width * c.height;
            const isPotentialBg = (nameLow.includes('bg') || nameLow.includes('background') || nameLow.includes('底'));
            
            if (isPotentialBg) {
                if (!bgNode || area > maxArea) {
                    bgNode = c;
                    maxArea = area;
                }
            }
        });

        if (bgNode) {
            console.log(`📏 Justifying ${comp.name} based on Background: ${bgNode.name} (${bgNode.width}x${bgNode.height})`);
            
            const offsetX = -bgNode.x;
            const offsetY = -bgNode.y;

            if (offsetX !== 0 || offsetY !== 0) {
                comp.children.forEach(c => {
                    c.x += offsetX;
                    c.y += offsetY;
                });
            }

            comp.width = bgNode.width;
            comp.height = bgNode.height;

            // Auto-Center Text
            comp.children.forEach(c => {
                const nameLow = c.name.toLowerCase();
                const isTitleName = nameLow.startsWith('n') || nameLow.includes('title') || nameLow.includes('text') || nameLow.includes('label');
                const isTextType = c.type === ObjectType.Text || c.type === ObjectType.RichText || c.type === ObjectType.InputText || c.type === ObjectType.Label;
                const isContainerType = c.type === ObjectType.Component || c.type === ObjectType.Group || c.type === ObjectType.Graph;

                if (isTextType || (isContainerType && isTitleName)) {
                    const isOutside = c.y < 0 || c.y + c.height > comp.height;
                    
                    if (isOutside) {
                        const newY = Math.round((comp.height - c.height) / 2);
                        console.log(`🎯 Auto-centering Text ${c.name}: ${c.y} -> ${newY}`);
                        c.y = newY;
                        if (c.x < 0) {
                            c.x = Math.round((comp.width - c.width) / 2);
                        }
                    }
                }
            });

        } else {
            // Fallback: Standard Normalization
            let minX = 0, minY = 0, maxX = comp.width, maxY = comp.height;
            let hasNegative = false;
            
            comp.children.forEach(c => {
                if (c.x < minX) { minX = c.x; hasNegative = true; }
                if (c.y < minY) { minY = c.y; hasNegative = true; }
                if (c.x + c.width > maxX) maxX = c.x + c.width;
                if (c.y + c.height > maxY) maxY = c.y + c.height;
            });

            if (hasNegative) {
                const offsetX = minX < 0 ? -minX : 0;
                const offsetY = minY < 0 ? -minY : 0;
                console.log(`📏 Normalizing ${comp.name}: Shifting bounds by (${offsetX}, ${offsetY})`);

                comp.children.forEach(c => {
                    c.x += offsetX;
                    c.y += offsetY;
                });
                comp.width = Math.max(comp.width, maxX + offsetX);
                comp.height = Math.max(comp.height, maxY + offsetY);
            }
        }

        if (res) {
            res.width = comp.width;
            res.height = comp.height;
        }
    };

    componentResources.forEach(res => {
        if (res.data) {
            try {
                const compRootFn = JSON.parse(res.data) as UINode;
                extractedNodesMap.set(res.id, compRootFn);
                
                // 💡 Skip image scanning for pure-shape components.
                // Their visuals are rendered as part of a parent node's SSR image.
                // Only scan components that have mixed content (text + shapes).
                const isPureShapeComponent = pipeline.isAtomicVisual(compRootFn);
                
                if (!isPureShapeComponent) {
                    // Match existing PNGs within extracted components
                    matchExistingPngs([compRootFn]);
                    // Scan for images to enqueue in pipeline
                    pipeline.scanAndEnqueue([compRootFn], allResources);
                } else {
                    console.log(`⏭️ Skipping image scan for pure-shape component: ${res.name}`);
                }

                // Normalize layout
                justifyComponentLayout(compRootFn, res);
                
                // Save updated node back to resource
                res.data = JSON.stringify(compRootFn);
            } catch (e) {
                console.warn(`Failed to parse/scan component resource: ${res.name}`, e);
            }
        }
    });

    // 4d. Scan root nodes for remaining images
    pipeline.scanAndEnqueue(rootNodes, allResources);

    // Normalize root nodes
    rootNodes.forEach(root => justifyComponentLayout(root));

    await fs.ensureDir(imgDir);

    // --- 5. 执行 Pipeline (批量获取 URL + 并发下载) ---
    await pipeline.execute();

    // --- 6. 生成 XML 阶段 ---
    // 💡 使用 Deterministic ID: 基于 Figma Node ID 生成 MD5
    const idSeed = FIGMA_NODE_ID || 'CloudPackage';
    let buildId = 'f2f' + crypto.createHash('md5').update(idSeed).digest('hex').substring(0, 5);
    console.log(`🆔 Package ID: ${buildId} (Derived from Node ID: ${idSeed})`);

    await fs.ensureDir(packagePath);
    const generator = new XMLGenerator();
    const validResources: ResourceInfo[] = [];

    const processedNames = new Set<string>();

    for (const res of componentResources) {
        if (res.type === 'component' && res.data) {
            let compNode = extractedNodesMap.get(res.id) || JSON.parse(res.data) as UINode;
            const hasVisuals = compNode.styles.fillType || compNode.styles.strokeSize;
            if (!compNode.children?.length && !hasVisuals) continue;
            const safeName = sanitizeFileName(res.name);
            
            if (processedNames.has(safeName)) {
                console.log(`Duplicate component skipped: ${safeName}`);
                continue;
            }
            
            const xmlContent = generator.generateComponentXml(compNode.children || [], buildId, compNode.width, compNode.height, compNode.styles, compNode.extention, compNode.controllers);
            await fs.writeFile(path.join(packagePath, safeName + '.xml'), xmlContent);
            
            res.name = safeName;
            validResources.push(res);
            processedNames.add(safeName);
        }
    }

    for (const node of rootNodes) {
        if (!node.children?.length && !node.styles.fillType) continue; 
        
        extractor.applyStandardNaming(node);

        const safeName = sanitizeFileName(node.name);
        
        const xmlContent = generator.generateComponentXml(node.children || [], buildId, node.width, node.height, node.styles, undefined, node.controllers);
        const fileName = `${safeName}.xml`;
        await fs.writeFile(path.join(packagePath, fileName), xmlContent);
        
        if (!processedNames.has(safeName)) {
            validResources.push({
                id: `main_${node.id.replace(/:/g, '_')}`,
                name: fileName,
                type: 'component',
                exported: true
            });
            processedNames.add(safeName);
        }
    }

    // Deduplicate image resources by ID (same image can be enqueued via component + root scans)
    const seenImageIds = new Set<string>();
    const uniqueImages = allResources.filter(r => {
        if (r.type !== 'image') return false;
        if (seenImageIds.has(r.id)) return false;
        seenImageIds.add(r.id);
        return true;
    });
    const finalResources = [...validResources, ...uniqueImages];
    const packageXml = generator.generatePackageXml(finalResources, buildId, packName);
    await fs.writeFile(path.join(packagePath, 'package.xml'), packageXml);

    console.log(`\n🎉 Success! FGUI Package generated at: ${packagePath}`);
}

main().catch(err => {
    console.error("💥 Critical Error:", err);
    process.exit(1);
});
