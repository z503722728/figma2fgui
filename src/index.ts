import * as fs from 'fs-extra';
import * as crypto from 'crypto';
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
import { getVisualPadding } from './Common';

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
    let figmaData: any;

    // --- 1. 获取数据阶段 ---
    if (await fs.pathExists(debugJsonPath)) {
        console.log(`🚀 发现本地调试缓存: ${debugJsonPath}`);
        console.log(`⚡ 跳过 API 请求，直接使用本地数据...`);
        const jsonContent = await fs.readFile(debugJsonPath, 'utf-8');
        figmaData = JSON.parse(jsonContent);
    } 
    
    if (!figmaData && FIGMA_TOKEN && FIGMA_FILE_KEY) {
        const client = new FigmaClient(FIGMA_TOKEN, FIGMA_FILE_KEY);
        
        if (FIGMA_NODE_ID) {
            figmaData = await client.getNodes([FIGMA_NODE_ID]);
        } else {
            figmaData = await client.getFile();
        }

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

    // --- 2.5 矢量合并优化 ---
    console.log("🌪️ 正在执行矢量合并优化...");
    const merger = new VectorMerger();
    merger.merge(rootNodes);

    // --- 3. 智能组件提取 ---
    console.log("🧩 正在执行智能组件提取...");
    const extractor = new SubComponentExtractor();
    const componentResources = extractor.extract(rootNodes);

    // --- 4. 资源处理 ---
    const allResources: ResourceInfo[] = [...componentResources];
    const client = new FigmaClient(FIGMA_TOKEN!, FIGMA_FILE_KEY!);
    
    const vectorNodes: UINode[] = [];
    const bitmapNodes: UINode[] = [];

    const findResourceNodes = (nodes: UINode[]) => {
        const scanner = (node: UINode) => {
            if (node.type === ObjectType.Image && (node.customProps?.fillGeometry || node.customProps?.mergedPaths)) {
                vectorNodes.push(node);
            }
            else if (node.styles.fillType === 'image' || node.type === ObjectType.Image) {
                if (!vectorNodes.includes(node)) {
                    bitmapNodes.push(node);
                }
            }
            if (node.children) node.children.forEach(scanner);
        };
        nodes.forEach(scanner);
    };

    findResourceNodes(rootNodes);

    const extractedNodesMap = new Map<string, UINode>();
    componentResources.forEach(res => {
        if (res.data) {
            try {
                const compRootFn = JSON.parse(res.data) as UINode;
                extractedNodesMap.set(res.id, compRootFn);
                findResourceNodes([compRootFn]); 
            } catch (e) {
                console.warn(`Failed to parse/scan component resource: ${res.name}`, e);
            }
        }
    });

    await fs.ensureDir(imgDir);

    const renderSvg = async (node: UINode, suffix: string = ""): Promise<ResourceInfo | null> => {
        const nodeIdStr = (node.sourceId || node.id).replace(/:/g, '_');
        const fileName = `${node.name}${suffix}_${nodeIdStr}.svg`;
        const localPath = path.join(imgDir, fileName);
        const padding = getVisualPadding(node);
        const width = node.width + padding * 2;
        const height = node.height + padding * 2;
        const vbX = -padding;
        const vbY = -padding;
        const vbW = node.width + padding * 2;
        const vbH = node.height + padding * 2;
        
        let svgBody = "";
        const defs: string[] = [];
        
        const addGradient = (g: any, id: string) => {
            if (g.type === 'GRADIENT_LINEAR') {
                const stops = g.stops.map((s: any) => `<stop offset="${s.offset * 100}%" stop-color="${s.color}" stop-opacity="${s.opacity}" />`).join('');
                const h1 = g.handles[0];
                const h2 = g.handles[1];
                defs.push(`<linearGradient id="${id}" x1="${h1.x * 100}%" y1="${h1.y * 100}%" x2="${h2.x * 100}%" y2="${h2.y * 100}%">${stops}</linearGradient>`);
            } else if (g.type === 'GRADIENT_RADIAL') {
                const stops = g.stops.map((s: any) => `<stop offset="${s.offset * 100}%" stop-color="${s.color}" stop-opacity="${s.opacity}" />`).join('');
                const h1 = g.handles[0];
                const h2 = g.handles[1];
                defs.push(`<radialGradient id="${id}" cx="${h1.x * 100}%" cy="${h1.y * 100}%" r="50%" fx="${h1.x * 100}%" fy="${h1.y * 100}%">${stops}</radialGradient>`);
            }
        };

        const addFilter = (filters: any[], id: string) => {
            let filterBody = "";
            filters.forEach((f, i) => {
                if (f.type === 'DROP_SHADOW') {
                    filterBody += `<feGaussianBlur in="SourceAlpha" stdDeviation="${f.radius / 2}" result="blur${i}"/>
                    <feOffset in="blur${i}" dx="${f.offset.x}" dy="${f.offset.y}" result="offsetBlur${i}"/>
                    <feFlood flood-color="${f.color}" flood-opacity="${f.opacity}" result="color${i}"/>
                    <feComposite in="color${i}" in2="offsetBlur${i}" operator="in" result="shadow${i}"/>
                    <feMerge result="merge${i}"><feMergeNode in="shadow${i}"/><feMergeNode in="SourceGraphic"/></feMerge>`;
                } else if (f.type === 'LAYER_BLUR') {
                    filterBody += `<feGaussianBlur in="SourceGraphic" stdDeviation="${f.radius / 2}" />`;
                }
            });
            defs.push(`<filter id="${id}" x="-20%" y="-20%" width="140%" height="140%">${filterBody}</filter>`);
        };

        if (node.customProps.mergedPaths) {
            const paths = node.customProps.mergedPaths;
            let currentMaskId = ""; 
            const renderedPaths: string[] = [];
            paths.forEach((p: any, idx: number) => {
                const pathId = `p${idx}`;
                let fillAttr = `fill="${p.fillColor}"`;
                let filterAttr = "";
                if (p.isMask) {
                    const maskId = `${pathId}_mask`;
                    const maskPathData = p.type === 'rect' 
                        ? `<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" rx="${p.cornerRadius}" fill="white" />`
                        : `<path d="${p.path}" transform="translate(${p.x},${p.y})" fill="white" />`;
                    defs.push(`<mask id="${maskId}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse"><rect width="100%" height="100%" fill="black" />${maskPathData}</mask>`);
                    if (currentMaskId) renderedPaths.push(`</g>`);
                    currentMaskId = maskId;
                    renderedPaths.push(`<g mask="url(#${maskId})">`);
                }
                if (p.gradient) {
                    const gradId = `${pathId}_grad`;
                    addGradient(p.gradient, gradId);
                    fillAttr = `fill="url(#${gradId})"`;
                }
                if (p.filters) {
                    const filtId = `${pathId}_filt`;
                    addFilter(p.filters, filtId);
                    filterAttr = `filter="url(#${filtId})"`;
                }
                const fo = p.fillOpacity !== undefined ? ` fill-opacity="${p.fillOpacity}"` : "";
                if (p.type === 'rect') {
                    const sc = p.strokeColor || 'none';
                    const sw = p.strokeSize || 0;
                    renderedPaths.push(`<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" ${fillAttr}${fo} rx="${p.cornerRadius}" stroke="${sc}" stroke-width="${sw}" ${filterAttr}${p.rotation ? ` transform="rotate(${p.rotation}, ${p.x + p.width / 2}, ${p.y + p.height / 2})"` : ""} />`);
                } else {
                    renderedPaths.push(`<path d="${p.path}" transform="translate(${p.x},${p.y})" ${fillAttr}${fo} stroke="${p.strokeColor || 'none'}" stroke-width="${p.strokeSize || 0}" ${filterAttr} />`);
                }
            });
            if (currentMaskId) renderedPaths.push(`</g>`);
            svgBody = renderedPaths.join('\n');
        } 
        else if (node.customProps.fillGeometry) {
            const paths = node.customProps.fillGeometry;
            let fillAttr = `fill="${node.styles.fillColor || "none"}"`;
            let filterAttr = "";
            if (node.styles.gradient) {
                const gradId = `sn_grad`;
                addGradient(node.styles.gradient, gradId);
                fillAttr = `fill="url(#${gradId})"`;
            }
            if (node.styles.filters) {
                const filtId = `sn_filt`;
                addFilter(node.styles.filters as any, filtId);
                filterAttr = `filter="url(#${filtId})"`;
            }
            const fillOpacity = node.styles.fillOpacity !== undefined ? ` fill-opacity="${node.styles.fillOpacity}"` : "";
            const strokeColor = node.styles.strokeColor || "none";
            const strokeSize = node.styles.strokeSize || 0;
            let pathData = Array.isArray(paths) ? paths.map((p: any) => p.path).join(' ') : "";
            if (pathData) svgBody = `<path d="${pathData}" ${fillAttr}${fillOpacity} stroke="${strokeColor}" stroke-width="${strokeSize}" ${filterAttr} />`;
        }

        if (svgBody) {
            const svgContent = `<svg width="${width}" height="${height}" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" fill="none" xmlns="http://www.w3.org/2000/svg"><defs>${defs.join('')}</defs>${svgBody}</svg>`;
            await fs.writeFile(localPath, svgContent.trim());
            return { 
                id: 'img_' + nodeIdStr + suffix.replace(/[^a-zA-Z0-9]/g, '_'), 
                name: fileName, 
                type: 'image',
                width: Math.round(width),
                height: Math.round(height)
            };
        }
        return null;
    };
    
    if (vectorNodes.length > 0) {
        console.log(`🎨 Generating ${vectorNodes.length} SVGs locally...`);
        for (const node of vectorNodes) {
            // 1. Render Normal Look (Page 0)
            const baseRes = await renderSvg(node);
            if (baseRes) {
                allResources.push(baseRes);
                node.src = baseRes.id;
                node.fileName = 'img/' + baseRes.name;

                // 2. Render Multi-State Looks
                if (node.multiLooks) {
                    const pageIds = Object.keys(node.multiLooks).map(Number);
                    const lookResMap: Record<number, string> = { 0: baseRes.id };
                    
                    for (const pageId of pageIds) {
                        const lookStyles = node.multiLooks[pageId];
                        // Clone node and apply modified styles
                        const lookNode = JSON.parse(JSON.stringify(node));
                        Object.assign(lookNode.styles, lookStyles);
                        
                        // Handle mergedPaths style propagation if applicable
                        if (lookNode.customProps.mergedPaths) {
                            lookNode.customProps.mergedPaths = lookNode.customProps.mergedPaths.map((p: any) => ({
                                ...p,
                                ...lookStyles // Crude but effective for simple states
                            }));
                        }

                        const lookRes = await renderSvg(lookNode, `_page${pageId}`);
                        if (lookRes) {
                            allResources.push(lookRes);
                            lookResMap[pageId] = lookRes.id;
                        }
                    }

                    // 3. Update gearIcon values (ui://pkg/res0|ui://pkg/res1...)
                    const gear = node.gears?.find(g => g.type === 'gearIcon');
                    if (gear) {
                        // For Button, standard pages are 0,1,2,3
                        const maxPage = Math.max(...pageIds, 3);
                        const values: string[] = [];
                        for (let p = 0; p <= maxPage; p++) {
                            // Link to the resource ID (XMLGenerator will prefix it if needed)
                            values.push(lookResMap[p] || baseRes.id);
                        }
                        gear.values = values.join('|');
                    }
                }
            }
        }
    }

    if (bitmapNodes.length > 0) {
        const nodesToDownload: UINode[] = [];
        for (const node of bitmapNodes) {
            const nodeIdStr = (node.sourceId || node.id).replace(/:/g, '_');
            const fileName = `${node.name}_${nodeIdStr}.png`;
            const localPath = path.join(imgDir, fileName);
            if (await fs.pathExists(localPath)) {
                const res: ResourceInfo = { 
                    id: 'img_' + nodeIdStr, 
                    name: fileName, 
                    type: 'image',
                    width: Math.round(node.width),
                    height: Math.round(node.height)
                };
                allResources.push(res);
                node.src = res.id;
                node.fileName = 'img/' + fileName;
            } else {
                nodesToDownload.push(node);
            }
        }
        if (nodesToDownload.length > 0) {
            console.log(`📡 Downloading ${nodesToDownload.length} Bitmaps...`);
            const ids = nodesToDownload.map(n => n.sourceId || n.id);
            const urls = await client.getImageUrls(ids, 'png');
            for (const node of nodesToDownload) {
                const srcId = node.sourceId || node.id;
                const url = urls[srcId];
                if (url) {
                    const fileName = `${node.name}_${srcId.replace(/:/g, '_')}.png`;
                    await client.downloadImage(url, path.join(imgDir, fileName));
                    const res: ResourceInfo = { 
                        id: 'img_' + srcId.replace(/:/g, '_'), 
                        name: fileName, 
                        type: 'image',
                        width: Math.round(node.width),
                        height: Math.round(node.height)
                    };
                    allResources.push(res);
                    node.src = res.id;
                    node.fileName = 'img/' + fileName;
                }
            }
        }
    }

    // --- 5. 生成 XML 阶段 ---
    // 💡 使用 Deterministic ID: 基于 Figma Node ID 生成 MD5
    // 这样即使重新生成，Package ID 也保持不变，不需要依赖旧文件
    const idSeed = FIGMA_NODE_ID || 'CloudPackage';
    let buildId = 'f2f' + crypto.createHash('md5').update(idSeed).digest('hex').substring(0, 5);
    console.log(`🆔 Package ID: ${buildId} (Derived from Node ID: ${idSeed})`);

    await fs.ensureDir(packagePath);
    const generator = new XMLGenerator();
    const validResources: ResourceInfo[] = [];

    for (const res of componentResources) {
        if (res.type === 'component' && res.data) {
            let compNode = extractedNodesMap.get(res.id) || JSON.parse(res.data) as UINode;
            const hasVisuals = compNode.styles.fillType || compNode.styles.strokeSize;
            if (!compNode.children?.length && !hasVisuals) continue;
            const xmlContent = generator.generateComponentXml(compNode.children || [], buildId, compNode.width, compNode.height, compNode.styles, compNode.extention, compNode.controllers);
            await fs.writeFile(path.join(packagePath, res.name + '.xml'), xmlContent);
            validResources.push(res);
        }
    }

    for (const node of rootNodes) {
        if (!node.children?.length && !node.styles.fillType) continue; 
        const xmlContent = generator.generateComponentXml(node.children || [], buildId, node.width, node.height, node.styles, undefined, node.controllers);
        const fileName = `${node.name}.xml`;
        await fs.writeFile(path.join(packagePath, fileName), xmlContent);
        
        validResources.push({
            id: `main_${node.id.replace(/:/g, '_')}`,
            name: fileName,
            type: 'component',
            exported: true
        });
    }

    const finalResources = [...validResources, ...allResources.filter(r => r.type === 'image')];
    const packageXml = generator.generatePackageXml(finalResources, buildId, packName);
    await fs.writeFile(path.join(packagePath, 'package.xml'), packageXml);

    console.log(`\n🎉 Success! FGUI Package generated at: ${packagePath}`);
}

main().catch(err => {
    console.error("💥 Critical Error:", err);
    process.exit(1);
});
