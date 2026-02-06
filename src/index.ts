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
import { getVisualPadding, sanitizeFileName } from './Common';

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
    let isFreshPull = false;


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
        isFreshPull = true;
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

    // Logic moved to after function definitions
    const allResources: ResourceInfo[] = [];
    const client = new FigmaClient(FIGMA_TOKEN!, FIGMA_FILE_KEY!);
    
    const vectorNodes: UINode[] = [];
    const bitmapNodes: UINode[] = [];

    // 💡 Pre-scan img directory for existing PNGs (Flexible Matching)
    let existingPngs: string[] = [];
    if (fs.existsSync(imgDir)) {
        existingPngs = fs.readdirSync(imgDir).filter(f => f.toLowerCase().endsWith('.png'));
        console.log(`🖼️ Found ${existingPngs.length} existing PNGs in cache.`);
    }

    // Pass 1: Scan for existing PNGs (Run BEFORE Merger)
    const scanForBitmaps = (nodes: UINode[]) => {
        const scanner = (node: UINode) => {
            if (node.visible === false) return;

            // 💡 Flexible Check for existing PNG
            const rawId = node.sourceId || node.id; 
            const sanitizedId = rawId.replace(/:/g, '_'); 
            const strictSanitizedId = rawId.replace(/[:;]/g, '_'); 

            let foundPng: string | undefined;

            // 1. Direct match (icon_ID.png)
            const exactName = `${sanitizeFileName(node.name)}_${sanitizedId}.png`;
            if (existingPngs.includes(exactName)) foundPng = exactName;

            // 2. Fuzzy/Name match (e.g. "icon_BtnBg_ID.png")
            // 💡 Fix: Must use strict suffix matching to avoid Parent matching Child's ID (which often contains Parent ID prefix)
            if (!foundPng && node.name) {
                foundPng = existingPngs.find(f => {
                    const fName = f.toLowerCase();
                    // Check if file ends with "_ID.png"
                    // We allow different name prefixes, but the ID part must match exactly at the end.
                    return fName.endsWith(`_${sanitizedId.toLowerCase()}.png`) || 
                        fName.endsWith(`_${strictSanitizedId.toLowerCase()}.png`);
                });
            }

            if (foundPng) {
                console.log(`🖼️ Matched existing PNG for ${node.name}: ${foundPng}`);
                node.customProps = node.customProps || {};
                node.customProps.manualPngName = foundPng;
                
                // 💡 CRITICAL: User request - If PNG exists, ignore children completely.
                // We clear the children array so no subsequence passes (Merger, Extractor, VectorScan)
                // even look inside.
                node.children = [];
                
                bitmapNodes.push(node);
                // Mark as handled so we don't recurse (treat as leaf)
                return;
            }

            if (node.children) node.children.forEach(scanner);
        };
        nodes.forEach(scanner);
    };

    // Pass 2: Scan for Vectors (Run AFTER Merger, BEFORE Extractor)
    const scanForVectors = (nodes: UINode[]) => {
        const scanner = (node: UINode) => {
            if (node.visible === false) return;

            // If already has src (from Pass 1 or manual), skip
            if (node.src) return;

            // Check for Vector candidacy
            const isVisual = (node.type === ObjectType.Image || node.type === ObjectType.Graph || 
                node.type === ObjectType.Component || node.type === ObjectType.Group || 
                node.type === ObjectType.Loader);
            
            // Only convert if it has checks/fills OR it's a merged node
            const hasVisualProps = (node.styles && (
                node.styles.fillColor || node.styles.strokeColor || node.styles.imageFill ||
                (node.styles.filters && node.styles.filters.length > 0)
            ));
            const isMerged = node.id.startsWith('merged_');
            const hasFillPaths = Array.isArray(node.customProps?.fillGeometry) && node.customProps.fillGeometry.length > 0;
            const hasMergedPaths = Array.isArray(node.customProps?.mergedPaths) && node.customProps.mergedPaths.length > 0;

            if (isVisual && (hasVisualProps || isMerged || hasFillPaths || hasMergedPaths)) {
                // Generate ID for potential SVG
                const srcId = (node.sourceId || node.id).replace(/:/g, '_');
                const resId = `img_${sanitizeFileName(node.name)}_${srcId}`;
                
                // Avoid duplicates in vectorNodes if rescanning
                if (!vectorNodes.includes(node)) {
                    const res: ResourceInfo = {
                        id: resId,
                        name: `${resId}.svg`,
                        type: 'image',
                        width: Math.round(node.width),
                        height: Math.round(node.height),
                        exported: false
                    };
                    
                    // Only add resource if not already present
                    if (!allResources.find(r => r.id === res.id)) {
                        allResources.push(res);
                    }
                    
                    node.src = res.id;
                    node.fileName = 'img/' + res.name;
                    vectorNodes.push(node); // Enqueue for SVG generation
                    
                    return; // Treat as leaf for vectorization
                }
            }

            if (node.children) node.children.forEach(scanner);
        };
        nodes.forEach(scanner);
    };

    // --- Step 0.5: Prefetch PNGs (New Feature) ---
    // Automatically fetch PNGs for nodes that "look like" images but aren't in cache yet.
    const prefetchPngs = async (nodes: UINode[]) => {
        console.log("🔍 Scanning for PNG candidates to prefetch...");
        const candidates: UINode[] = [];
        
        const finder = (node: UINode) => {
            if (node.visible === false) return;
             
            // Check if already cached
            const rawId = node.sourceId || node.id;
            const sanitizedId = rawId.replace(/:/g, '_');
            const strictSanitizedId = rawId.replace(/[:;]/g, '_');
             
            // Quick check if file exists (loose or strict)
            const alreadyCached = existingPngs.some(f => {
                const fName = f.toLowerCase();
                return fName.endsWith(`_${sanitizedId.toLowerCase()}.png`) || 
                    fName.endsWith(`_${strictSanitizedId.toLowerCase()}.png`);
            });
             
            if (alreadyCached) return;

            // Heuristic for "Should be PNG":
            // 1. Name starts with 'icon' or 'img'
            // 2. Name contains 'bg' / 'background' AND it's a vector-like type (not just a frame)
            // 3. Explicitly typed as Image (but no src yet)
            const nameLow = node.name.toLowerCase();
            const isIcon = nameLow.startsWith('icon') || nameLow.startsWith('img');
            const isBg = nameLow.includes('bg') || nameLow.includes('background') || nameLow.includes('底');
             
            // We only prefetch if it's not a basic Text node or generic Group unless it matches naming convention
            if (node.type !== ObjectType.Text) {
                if (isIcon || isBg || node.type === ObjectType.Image) {
                    candidates.push(node);
                    // Don't recurse into candidates we intend to rasterize entirely
                    // return; 
                    // Actually, we might want to be careful. If we prefetch a container, we assume it's a leaf.
                    // But let's stick to the prunign logic: if we download it, we prune it later.
                    return; 
                }
            }

            if (node.children) node.children.forEach(finder);
        };
        nodes.forEach(finder);

        if (candidates.length === 0) {
            console.log("✅ No new PNG candidates found.");
            return;
        }

        console.log(`🚀 Found ${candidates.length} candidates for PNG prefetch. Fetching URLs...`);
        const ids = candidates.map(n => n.sourceId || n.id);
        
        try {
            // Batch Request URLs
            const images = await client.getImageUrls(ids, 'png'); // returns { nodeId: url }
            
            if (!images) {
                console.warn("⚠️ Failed to get image URLs from Figma.");
                return;
            }

            const downloadPromises: Promise<void>[] = [];
            
            // Map back to nodes to determine filenames
            for (const node of candidates) {
                const id = node.sourceId || node.id;
                const url = images[id];
                if (url) {
                    const sanitizedId = id.replace(/:/g, '_');
                    const fileName = `${sanitizeFileName(node.name)}_${sanitizedId}.png`;
                    const filePath = path.join(imgDir, fileName);
                    
                    console.log(`⬇️ Downloading: ${fileName}`);
                    downloadPromises.push(
                        client.downloadImage(url, filePath).then(() => {
                            existingPngs.push(fileName); // Update cache list so next step finds it
                        }).catch(e => {
                            console.error(`❌ Failed to download ${fileName}:`, e.message);
                        })
                    );
                }
            }
            
            await Promise.all(downloadPromises);
            console.log(`✨ Prefetch complete. new cache size: ${existingPngs.length}`);

        } catch (e) {
            console.error("⚠️ Prefetch encountered an error:", e);
        }
    };

    // Execute Prefetch
    if (isFreshPull) {
        console.log("⬇️ 正在检查并预取 PNG 资源...");
        await prefetchPngs(rootNodes);
    } else {
        console.log("⏩ 跳过 PNG 预取 (使用本地缓存数据)...");
    }

    // --- Step 1: Scan for Bitmaps (Pre-Merge) ---
    // This allows us to identify nodes that map to existing PNGs, preventing them from being merged.
    console.log("🔍 Scanning for existing bitmaps...");
    scanForBitmaps(rootNodes);

    // --- Step 2: Vector Merging ---
    // Now runs AFTER bitmap scan (skipping identified bitmaps)
    console.log("🌪️ 正在执行矢量合并优化...");
    const merger = new VectorMerger();
    merger.merge(rootNodes);

    // --- Step 3: Component Extraction ---
    console.log("🧩 正在执行智能组件提取...");
    const extractor = new SubComponentExtractor();
    const componentResources = extractor.extract(rootNodes);

    // --- Step 4: Post-Extraction Scan (Vectors & Remaining Bitmaps) ---
    // 4a. Scan Extracted Components (CRITICAL: Must re-serialize changes!)
    // Populate allResources with components first
    allResources.push(...componentResources);
    
    const extractedNodesMap = new Map<string, UINode>();
    
    // --- Definition of Normalization Logic ---
    // --- Definition of Layout Justification Logic ---
    const justifyComponentLayout = (comp: UINode, res?: ResourceInfo) => {
        if (!comp.children || comp.children.length === 0) return;

        // 1. Identify "Background" Node
        // Heuristic: Name contains 'bg'/'background' OR it's the largest child matching component size approx OR it's the first child Image
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

        // 2. Normalization Strategy
        if (bgNode) {
            console.log(`📏 Justifying ${comp.name} based on Background: ${bgNode.name} (${bgNode.width}x${bgNode.height})`);
            
            // A. Shift everything so Background is at (0,0)
            const offsetX = -bgNode.x;
            const offsetY = -bgNode.y;

            if (offsetX !== 0 || offsetY !== 0) {
                comp.children.forEach(c => {
                    c.x += offsetX;
                    c.y += offsetY;
                });
            }

            // B. Set Component Size to Background Size (User Requirement)
            comp.width = bgNode.width;
            comp.height = bgNode.height;

            // C. Auto-Center Text (Good Taste)
            // If Text is misplaced (e.g. negative Y or outside), force center it.
            // Condition: Text node, and (y < 0 or name indicates title/center)
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
                        
                        // Also center Horizontal if needed?
                        // If it deviates too much, maybe? Let's check X.
                        // For now trust X unless also negative.
                        if (c.x < 0) {
                            const newX = Math.round((comp.width - c.width) / 2);
                            c.x = newX;
                        }
                    }
                }
            });

        } else {
            // Fallback: Standard Normalization (Shift to 0,0)
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

        // Update Resource Info if provided
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
                
                // Scan content for vectors/bitmaps that need processing
                scanForBitmaps([compRootFn]);
                scanForVectors([compRootFn]);

                // 💡 NORMALIZE (Extracted Components)
                justifyComponentLayout(compRootFn, res);
                
                // 💡 CRITICAL: Save the updated node (with .src assigned) back to the resource
                res.data = JSON.stringify(compRootFn);
            } catch (e) {
                console.warn(`Failed to parse/scan component resource: ${res.name}`, e);
            }
        }
    });

    // 4b. Scan Root Nodes (for anything left in the main tree)
    scanForVectors(rootNodes);

    // 💡 NORMALIZE (Root Nodes)
    rootNodes.forEach(root => justifyComponentLayout(root));

    await fs.ensureDir(imgDir);



    const renderSvg = async (node: UINode, suffix: string = ""): Promise<ResourceInfo | null> => {
        const nodeIdStr = (node.sourceId || node.id).replace(/:/g, '_');
        const fileName = `${sanitizeFileName(node.name)}${suffix}_${nodeIdStr}.svg`;
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
            
            // 💡 Use manually found PNG if available (from flexible lookup)
            const manualName = node.customProps?.manualPngName;
            const fileName = manualName || `${sanitizeFileName(node.name)}_${nodeIdStr}.png`;
            const localPath = path.join(imgDir, fileName);

            // If manualName is set, we know it exists (checked in scanner)
            if (manualName || await fs.pathExists(localPath)) {
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
            try {
                const ids = nodesToDownload.map(n => n.sourceId || n.id);
                const urls = await client.getImageUrls(ids, 'png');
                for (const node of nodesToDownload) {
                    const srcId = node.sourceId || node.id;
                    const url = urls[srcId];
                    if (url) {
                        const fileName = `${sanitizeFileName(node.name)}_${srcId.replace(/:/g, '_')}.png`;
                        try {
                            await client.downloadImage(url, path.join(imgDir, fileName));
                        } catch (err) {
                            console.warn(`⚠️ Failed to download image ${fileName}:`, err);
                            continue; // Keep going
                        }
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
            } catch (error) {
                console.error("❌ Error during bitmap batch processing:", error);
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
            
            // Update name for package.xml consistency
            res.name = safeName;
            validResources.push(res);
            processedNames.add(safeName);
        }
    }


    for (const node of rootNodes) {
        if (!node.children?.length && !node.styles.fillType) continue; 
        
        // 💡 Ensure root nodes also get standard naming (icon/title conversions)
        // This is critical if the root node overwrites an extracted component file
        extractor.applyStandardNaming(node);

        const safeName = sanitizeFileName(node.name);
        // Root nodes usually overwrite components if they share names, but for package.xml we just need one entry
        // If it's already processed as a component, we still generate the file (it might be the 'main' export)
        // but we should avoid duplicate package.xml entries if possible.
        // However, root nodes are often "main" and might need distinct ID handling if they are indeed the same name.
        // For FGUI, one file = one resource. 
        
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

    const finalResources = [...validResources, ...allResources.filter(r => r.type === 'image')];
    const packageXml = generator.generatePackageXml(finalResources, buildId, packName);
    await fs.writeFile(path.join(packagePath, 'package.xml'), packageXml);

    console.log(`\n🎉 Success! FGUI Package generated at: ${packagePath}`);
}

main().catch(err => {
    console.error("💥 Critical Error:", err);
    process.exit(1);
});
