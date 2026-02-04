import * as fs from 'fs-extra';
import * as path from 'path';
import * as dotenv from 'dotenv';
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

    let rootNodes: UINode[] = [];

    // --- 1. 获取数据阶段 ---
    if (FIGMA_TOKEN && FIGMA_FILE_KEY) {
        const client = new FigmaClient(FIGMA_TOKEN, FIGMA_FILE_KEY);
        let figmaData: any;

        if (FIGMA_NODE_ID) {
            figmaData = await client.getNodes([FIGMA_NODE_ID]);
        } else {
            figmaData = await client.getFile();
        }
        
        const rawParser = new RawFigmaParser();
        rootNodes = rawParser.parse(figmaData);
    } else {
        console.error("❌ 缺少 Figma 凭据，无法从云端获取数据。请检查 .env 文件。");
        process.exit(1);
    }

    // --- 2. 布局计算 ---
    const calculator = new FlexLayoutCalculator();
    calculator.calculate(rootNodes);

    // --- 3. 智能组件提取 ---
    console.log("🧩 正在执行智能组件提取...");
    const extractor = new SubComponentExtractor();
    const componentResources = extractor.extract(rootNodes);

    // --- 4. 自动化图片下载 (REST API) ---
    const allResources: ResourceInfo[] = [...componentResources];
    const client = new FigmaClient(FIGMA_TOKEN!, FIGMA_FILE_KEY!);
    
    const imageNodes: UINode[] = [];
    const findImageNodes = (node: UINode) => {
        // 💡 改进：凡是标记为 Image 类型的节点（包括复杂矢量、带渐变的背景、图片填充）均自动抓取
        if (node.styles.fillType === 'image' || node.type === ObjectType.Image) imageNodes.push(node);
        if (node.children) node.children.forEach(findImageNodes);
    };
    rootNodes.forEach(findImageNodes);

    if (imageNodes.length > 0) {
        console.log(`📡 检测到 ${imageNodes.length} 个资源节点，准备通过云端渲染下载...`);
        const urls = await client.getImageUrls(imageNodes.map(n => n.id));
        const imgDir = path.join(finalOutputDir, packName, 'img');
        await fs.ensureDir(imgDir);

        for (const node of imageNodes) {
            const url = urls[node.id];
            if (url) {
                const fileName = `${node.name}_${node.id.replace(/:/g, '_')}.png`;
                await client.downloadImage(url, path.join(imgDir, fileName));
                const res: ResourceInfo = {
                    id: 'img_' + node.id.replace(/:/g, '_'),
                    name: fileName,
                    type: 'image'
                };
                allResources.push(res);
                node.src = res.id;
                node.fileName = 'img/' + fileName;
                console.log(`📥 下载完成: ${fileName}`);
            }
        }
    }

    // --- 5. 生成 XML 阶段 ---
    const buildId = 'f2f' + Math.random().toString(36).substring(2, 7);
    const packagePath = path.join(finalOutputDir, packName);
    await fs.ensureDir(packagePath);
    const generator = new XMLGenerator();

    const validResources: ResourceInfo[] = [];

    // 5.1 生成子组件 XML
    for (const res of componentResources) {
        if (res.type === 'component' && res.data) {
            const compNode = JSON.parse(res.data) as UINode;
            
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
