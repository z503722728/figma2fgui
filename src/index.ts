import * as fs from 'fs-extra';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { VectorMerger } from './optimizer/VectorMerger';
import { FigmaParser } from './FigmaParser';
import { RawFigmaParser } from './RawFigmaParser';
import { XMLGenerator } from './generator/XMLGenerator';
import { FlexLayoutCalculator } from './FlexLayoutCalculator';
import { SubComponentExtractor } from './generator/SubComponentExtractor';
import { FigmaClient } from './FigmaClient';
import { UINode, ResourceInfo } from './models/UINode';
import { ObjectType } from './models/FGUIEnum';

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

    const defaultOutputDir = path.join(__dirname, '../output/FigmaProject');
    const finalOutputDir = OUTPUT_PATH || defaultOutputDir;
    const packName = FIGMA_NODE_ID ? `Node_${FIGMA_NODE_ID.replace(':', '_')}` : 'CloudPackage';
    const packagePath = path.join(finalOutputDir, packName);
    const imgDir = path.join(packagePath, 'img');

    // --- 0. 环境清理 (保留图片缓存) ---
    if (await fs.pathExists(packagePath)) {
        console.log(`🧹 检测到现有目录，正在清理旧 XML 文件 (保留 img 缓存)...`);
        const files = await fs.readdir(packagePath);
        for (const file of files) {
            const fullPath = path.join(packagePath, file);
            const stat = await fs.stat(fullPath);
            // 只要不是 img 目录，且是 xml 文件(或 meta 文件)，就删除
            // 安全起见：只删 xml
            if (!stat.isDirectory() && file.endsWith('.xml')) {
                await fs.unlink(fullPath);
            }
        }
    }
    
    // Clean img directory for stale SVGs (but keep PNGs to save download time)
    if (await fs.pathExists(imgDir)) {
        console.log(`🧹 清理旧 SVG 资源...`);
        const imgFiles = await fs.readdir(imgDir);
        for (const file of imgFiles) {
            if (file.endsWith('.svg')) {
                await fs.unlink(path.join(imgDir, file));
            }
        }
    }

    let rootNodes: UINode[] = [];

    // --- 1. 获取数据阶段 ---
    // --- 1. 获取数据阶段 ---
    let figmaData: any;
    const debugJsonPath = path.join(packagePath, 'figma_debug.json');

    if (await fs.pathExists(debugJsonPath)) {
        console.log(`🚀 发现本地调试缓存: ${debugJsonPath}`);
        console.log(`⚡ 跳过 API 请求，直接使用本地数据...`);
        const jsonContent = await fs.readFile(debugJsonPath, 'utf-8');
        figmaData = JSON.parse(jsonContent);
        
        // 如果有 NODE_ID，过滤数据（可选，因为缓存的通常就是我们需要的数据）
        // 但为了保险，还是初始化 client 以便后续下载图片
    } 
    
    if (!figmaData && FIGMA_TOKEN && FIGMA_FILE_KEY) {
        const client = new FigmaClient(FIGMA_TOKEN, FIGMA_FILE_KEY);
        
        if (FIGMA_NODE_ID) {
            figmaData = await client.getNodes([FIGMA_NODE_ID]);
        } else {
            figmaData = await client.getFile();
        }

        // 🐛 Debug: 保存原始 JSON
        await fs.ensureDir(packagePath);
        await fs.writeFile(debugJsonPath, JSON.stringify(figmaData, null, 2));
        console.log(`🐛 原始 Figma 数据已保存至: ${debugJsonPath}`);
    } else if (!figmaData) {
        console.error("❌ 缺少本地缓存且缺少 Figma 凭据，无法获取数据。请检查 .env 文件。");
        process.exit(1);
    }

    const rawParser = new RawFigmaParser();
    rootNodes = rawParser.parse(figmaData);

    // --- 2. 布局计算 ---
    const calculator = new FlexLayoutCalculator();
    calculator.calculate(rootNodes);

    // --- 2.5 矢量合并优化 (Vector Merger) ---
    console.log("🌪️ 正在执行矢量合并优化...");
    const merger = new VectorMerger();
    merger.merge(rootNodes);

    // --- 3. 智能组件提取 ---
    console.log("🧩 正在执行智能组件提取...");
    const extractor = new SubComponentExtractor();
    const componentResources = extractor.extract(rootNodes);

    // --- 4. 自动化图片下载 (Smart Cache) ---
    const allResources: ResourceInfo[] = [...componentResources];
    const client = new FigmaClient(FIGMA_TOKEN!, FIGMA_FILE_KEY!);
    
    // --- 4. 资源处理 (Local SVG Gen + Smart Download) ---
    const vectorNodes: UINode[] = [];
    const bitmapNodes: UINode[] = [];
    const imageNodes: UINode[] = []; // Deprecated but kept for reference if needed, we split now

    const findResourceNodes = (nodes: UINode[]) => {
        const scanner = (node: UINode) => {
            // 1. Vector Nodes -> Generate Local SVG
            // Support both single path (fillGeometry) and merged paths (mergedPaths)
            if (node.type === ObjectType.Image && (node.customProps?.fillGeometry || node.customProps?.mergedPaths)) {
                vectorNodes.push(node);
            }
            // 2. Bitmap Fills -> Request PNG
            else if (node.styles.fillType === 'image' || node.type === ObjectType.Image) {
                // Check if not already in vectorNodes
                if (!vectorNodes.includes(node)) {
                    bitmapNodes.push(node);
                }
            }
            
            if (node.children) node.children.forEach(scanner);
        };
        nodes.forEach(scanner);
    };

    // 4.1 Scan Root Nodes
    findResourceNodes(rootNodes);

    // 4.2 Scan Extracted Components (Crucial! Sub-components contain hidden vectors)
    // 💡 Fix: Keep parsed objects in memory so updates to 'src' persist
    const extractedNodesMap = new Map<string, UINode>();
    
    componentResources.forEach(res => {
        if (res.data) {
            try {
                const compRootFn = JSON.parse(res.data) as UINode;
                extractedNodesMap.set(res.id, compRootFn);
                
                const nodeList = [compRootFn]; 
                findResourceNodes(nodeList); 

                // ❌ DO NOT serialize back yet! Wait for download loops to update 'src'.
            } catch (e) {
                console.warn(`Failed to parse/scan component resource: ${res.name}`, e);
            }
        }
    });

    await fs.ensureDir(imgDir);
    
    // 4.1 Local SVG Generation
    if (vectorNodes.length > 0) {
        console.log(`🎨 Generating ${vectorNodes.length} SVGs locally...`);
        for (const node of vectorNodes) {
            const nodeIdStr = (node.sourceId || node.id).replace(/:/g, '_');
            const fileName = `${node.name}_${nodeIdStr}.svg`;
            const localPath = path.join(imgDir, fileName);
             
            // Construct SVG Content
            const width = node.width;
            const height = node.height;
            let svgBody = "";

            // Case A: Merged Paths (from VectorMerger)
            if (node.customProps.mergedPaths) {
                const paths = node.customProps.mergedPaths;
                svgBody = paths.map((p: any) => {
                    if (p.type === 'rect') {
                        return `<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" fill="${p.fillColor}" rx="${p.cornerRadius}" />`;
                    } else { // path
                        return `<path d="${p.path}" transform="translate(${p.x},${p.y})" fill="${p.fillColor}" stroke="${p.strokeColor || 'none'}" stroke-width="${p.strokeSize || 0}" />`;
                    }
                }).join('\n');
            } 
            // Case B: Single Path (Original Logic)
            else if (node.customProps.fillGeometry) {
                const paths = node.customProps.fillGeometry;
                const fillColor = node.styles.fillColor || "#000000";
                let pathData = "";
                if (Array.isArray(paths)) {
                    pathData = paths.map((p: any) => p.path).join(' ');
                }
                if (pathData) {
                    svgBody = `<path d="${pathData}" fill="${fillColor}"/>`;
                }
            }

            if (svgBody) {
                const svgContent = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
${svgBody}
</svg>`;
                await fs.writeFile(localPath, svgContent.trim());
                 
                const res: ResourceInfo = {
                    id: 'img_' + nodeIdStr,
                    name: fileName,
                    type: 'image'
                };
                allResources.push(res);
                node.src = res.id;
                node.fileName = 'img/' + fileName;
                // console.log(`💾 SVG Generated: ${fileName}`);
            } else {
                // Fallback to bitmap if path missing
                console.warn(`⚠️ Missing path data for ${node.name}, falling back to PNG.`);
                bitmapNodes.push(node);
            }
        }
    }

    // 4.2 Bitmap Download (PNG)
    if (bitmapNodes.length > 0) {
        // ... (standard PNG download logic)
        const nodesToDownload: UINode[] = [];
        for (const node of bitmapNodes) {
            const nodeIdStr = (node.sourceId || node.id).replace(/:/g, '_');
            const fileName = `${node.name}_${nodeIdStr}.png`;
            const localPath = path.join(imgDir, fileName);
             
            if (await fs.pathExists(localPath)) {
                const res: ResourceInfo = {
                    id: 'img_' + nodeIdStr,
                    name: fileName,
                    type: 'image'
                };
                allResources.push(res);
                node.src = res.id;
                node.fileName = 'img/' + fileName;
            } else {
                nodesToDownload.push(node);
            }
        }
        
        if (nodesToDownload.length > 0) {
            console.log(`📡 Downloading ${nodesToDownload.length} Bitmaps as PNG...`);
            const ids = nodesToDownload.map(n => n.sourceId || n.id);
            const urls = await client.getImageUrls(ids, 'png');
            
            for (const node of nodesToDownload) {
                const srcId = node.sourceId || node.id;
                const url = urls[srcId];
                if (url) {
                    const nodeIdStr = srcId.replace(/:/g, '_');
                    const fileName = `${node.name}_${nodeIdStr}.png`;
                    await client.downloadImage(url, path.join(imgDir, fileName));
                    
                    const res: ResourceInfo = {
                        id: 'img_' + nodeIdStr,
                        name: fileName,
                        type: 'image'
                    };
                    allResources.push(res);
                    node.src = res.id;
                    node.fileName = 'img/' + fileName;
                    console.log(`📥 PNG Downloaded: ${fileName}`);
                } else {
                    console.warn(`⚠️ Image URL missing: ${node.name}`);
                }
            }
        }
    }

    // --- 5. 生成 XML 阶段 ---
    const buildId = 'f2f' + Math.random().toString(36).substring(2, 7);
    // const packagePath = path.join(finalOutputDir, packName); // Moved up
    await fs.ensureDir(packagePath);
    const generator = new XMLGenerator();

    const validResources: ResourceInfo[] = [];

    // 5.1 生成子组件 XML
    for (const res of componentResources) {
        if (res.type === 'component' && res.data) {
            // Use the live object if available (contains updated src), otherwise parse fresh
            let compNode: UINode;
            if (extractedNodesMap.has(res.id)) {
                compNode = extractedNodesMap.get(res.id)!;
                // Update res.data for final package integrity (optional but good)
                res.data = JSON.stringify(compNode);
            } else {
                compNode = JSON.parse(res.data) as UINode;
            }
            
            const hasVisuals = compNode.styles.fillType || compNode.styles.strokeSize;
            if (!compNode.children?.length && !hasVisuals) {
                console.log(`🧹 忽略无效子组件: ${res.name}`);
                continue;
            }

            const xmlContent = generator.generateComponentXml(compNode.children || [], buildId, compNode.width, compNode.height, compNode.styles);
            await fs.writeFile(path.join(packagePath, res.name + '.xml'), xmlContent);
            validResources.push(res);
            console.log(`📦 生成子组件: ${res.name}.xml`);
        }
    }

    // 5.2 生成主组件 XML
    for (const node of rootNodes) {
        if (!node.children?.length && !node.styles.fillType) continue; 
        
        const xmlContent = generator.generateComponentXml(node.children || [], buildId, node.width, node.height, node.styles);
        await fs.writeFile(path.join(packagePath, `${node.name}.xml`), xmlContent);
        console.log(`📝 生成主组件: ${node.name}.xml`);
    }

    // 合并资源并生成 Package XML
    const finalResources = [...validResources, ...allResources.filter(r => r.type === 'image')];
    const packageXml = generator.generatePackageXml(finalResources, buildId, packName);
    await fs.writeFile(path.join(packagePath, 'package.xml'), packageXml);

    console.log(`\n🎉 Success! FGUI Package generated at: ${packagePath}`);
}

main().catch(err => {
    console.error("💥 Critical Error:", err);
    process.exit(1);
});
