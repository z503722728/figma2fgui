import { UINode, ResourceInfo } from "../models/UINode";
import { ObjectType } from "../models/FGUIEnum";

/**
 * SubComponentExtractor: Walks the UINode tree and extracts Containers into proper FGUI Component References.
 */
export class SubComponentExtractor {
    private _newResources: ResourceInfo[] = [];
    private _nextCompId = 0;
    private _componentCache = new Map<string, ResourceInfo>();
    private _candidateGroups = new Map<string, UINode[]>();

    public extract(rootNodes: UINode[]): ResourceInfo[] {
        this._newResources = [];
        this._nextCompId = 0;
        this._componentCache.clear();
        this._candidateGroups.clear();

        // Phase 1: Bottom-Up candidate collection
        for (const root of rootNodes) {
            this.collectCandidatesRecursive(root);
        }

        // Phase 2: Analyze and Pre-register Resources
        const usedNames = new Map<string, number>(); // name -> count for dedup
        for (const [hash, instances] of this._candidateGroups.entries()) {
            if (instances.length === 0) continue;
            const canonical = instances[0];

            // 💡 Registering the resource structure early so Phase 3 can find it
            const resId = `comp_` + (this._nextCompId++);
            let safeName = canonical.name.replace(/\s+/g, '');
            
            // Handle name collisions: append numeric suffix for variants
            if (usedNames.has(safeName)) {
                const count = usedNames.get(safeName)!;
                usedNames.set(safeName, count + 1);
                safeName = `${safeName}_${count}`;
            } else {
                usedNames.set(safeName, 1);
            }
            
            const preRes: ResourceInfo = {
                id: resId,
                name: safeName,
                type: 'component',
                data: "" // To be populated in Phase 4
            };
            this._componentCache.set(hash, preRes);
            
            this.analyzeMultiLooks(canonical, instances);
        }

        // Phase 3: Transformation (Process all nodes to use component references)
        // Transform candidates nodes first
        for (const group of this._candidateGroups.values()) {
            for (const inst of group) {
                this.transformTreeRecursive(inst);
                this.detectAndApplyStates(inst);
            }
        }
        // Transform root nodes
        for (const root of rootNodes) {
            this.transformTreeRecursive(root);
            this.detectAndApplyStates(root);
        }

        // Phase 4: Finalize Resource Data (Serialization)
        for (const [hash, instances] of this._candidateGroups.entries()) {
            const canonical = instances[0];
            const cachedRes = this._componentCache.get(hash)!;
            
            const cleanNode = this.stripParent(canonical);
            
            // Apply FGUI Extension mapping
            const extensionMap: Record<number, string> = {
                [ObjectType.Button]: 'Button',
                [ObjectType.ProgressBar]: 'ProgressBar',
                [ObjectType.Slider]: 'Slider',
                [ObjectType.ComboBox]: 'ComboBox',
                [ObjectType.Label]: 'Label',
                [ObjectType.List]: 'List'
            };
            if (extensionMap[canonical.type]) {
                cleanNode.extention = extensionMap[canonical.type];
                this.applyStandardNaming(cleanNode);
            }

            // 💡 将 multiLooks 和 gearIcon 从组件根节点传播到 "icon" 子节点。
            // analyzeMultiLooks 将 multiLooks/gears 设置在组件根上，
            // 但 ImagePipeline.scanAndEnqueue 检查的是被扫描节点自身的 multiLooks。
            // FGUI 中实际切换图片的是 icon Loader，所以需要将 multiLooks 移到 icon 上。
            if (cleanNode.multiLooks && cleanNode.children) {
                const iconChild = cleanNode.children.find(c => c.name === 'icon');
                if (iconChild) {
                    iconChild.multiLooks = cleanNode.multiLooks;
                    // 将 gearIcon 类型的 gear 移到 icon 子节点
                    const gearIcons = (cleanNode.gears || []).filter(g => g.type === 'gearIcon');
                    if (gearIcons.length > 0) {
                        iconChild.gears = (iconChild.gears || []).concat(gearIcons);
                    }
                    // 从根节点移除（避免重复）
                    delete cleanNode.multiLooks;
                    cleanNode.gears = (cleanNode.gears || []).filter(g => g.type !== 'gearIcon');
                }
            }

            cachedRes.data = JSON.stringify(cleanNode);
            this._newResources.push(cachedRes);
        }

        return this._newResources;
    }

    private collectCandidatesRecursive(node: UINode): void {
        // Skip invisible nodes unless they are likely state variants
        if (node.visible === false) {
            const nameLow = node.name.toLowerCase();
            const stateKeywords = ['hover', 'pressed', 'down', 'selected', 'checked', 'disabled', '悬停', '按下', '选中'];
            const isState = stateKeywords.some(k => nameLow.includes(k));
            if (!isState) return;
        }

        if (!node.children || node.children.length === 0) return;

        for (const child of node.children) {
            this.collectCandidatesRecursive(child);
        }

        // 💡 Pure shape groups should NOT be extracted as components.
        // They will be rendered as single SSR images by ImagePipeline.
        if (this.allDescendantsAreShapes(node)) {
            return;
        }

        const isExtensionType = (
            node.type === ObjectType.Button || 
            node.type === ObjectType.Label || 
            node.type === ObjectType.ProgressBar || 
            node.type === ObjectType.Slider || 
            node.type === ObjectType.ComboBox || 
            node.type === ObjectType.List
        );

        // 💡 Containers with mask descendants use alpha masking / clipping effects
        // that require Figma SSR to render correctly. Don't extract as components.
        // BUT: Extension types (Button, Label, etc.) must ALWAYS be extracted as FGUI
        // components, even if they contain mask descendants deep inside (e.g. decorative elements).
        // The mask sub-elements will be handled by ImagePipeline as SSR images.
        if (!isExtensionType && this.hasMaskDescendants(node)) {
            return;
        }

        const hasNestedExtracted = node.children.some(c => c.asComponent);
        const hasVisuals = (node.styles.background || node.styles.backgroundColor || node.styles.border || node.styles.outline);
        
        const isSignificant = node.children.length > 2 || 
            isExtensionType || 
            hasNestedExtracted ||
            (hasVisuals && node.children.length > 0);

        // 💡 Exclusions: explicit ignore list
        if (node.name.toLowerCase().includes('btntext')) {
            return;
        }

        if (isSignificant) {
            const hash = this.calculateStructuralHash(node);
            if (!this._candidateGroups.has(hash)) {
                this._candidateGroups.set(hash, []);
            }
            this._candidateGroups.get(hash)!.push(node);
            node.asComponent = true;
            node._structuralHash = hash; // 💡 缓存原始 hash，Phase 3 变换后子树会变化导致重算不一致
        }
    }

    /**
     * Recursively checks if any descendant (including invisible ones) has isMask: true.
     * Containers with mask descendants use Figma alpha masking / clipping effects
     * that must be SSR-rendered as a whole, not extracted as sub-components.
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
     * Checks if ALL descendants of a node are purely graphical shapes.
     * Used to skip component extraction for pure-shape groups that will
     * be rendered as single SSR images.
     */
    private allDescendantsAreShapes(node: UINode): boolean {
        if (!node.children || node.children.length === 0) return true;
        for (const child of node.children) {
            if (child.type === ObjectType.Text || child.type === ObjectType.RichText || child.type === ObjectType.InputText) {
                return false;
            }
            if (child.type === ObjectType.Button || child.type === ObjectType.Label ||
                child.type === ObjectType.ProgressBar || child.type === ObjectType.Slider ||
                child.type === ObjectType.ComboBox || child.type === ObjectType.List) {
                return false;
            }
            if (child.type === ObjectType.Image || child.type === ObjectType.Graph) continue;
            if (!this.allDescendantsAreShapes(child)) return false;
        }
        return true;
    }

    private transformTreeRecursive(node: UINode): void {
        if (!node.children) return;

        for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            
            if (child.asComponent) {
                // 💡 使用缓存的 hash：Phase 3a 变换候选节点后，子树结构已变化，
                // 重新计算 hash 会得到不同的值，导致在 _componentCache 中找不到资源。
                const hash = child._structuralHash || this.calculateStructuralHash(child);
                const compRes = this._componentCache.get(hash);

                if (compRes) {
                    const refNode: UINode = {
                        id: child.id,
                        sourceId: child.sourceId,
                        name: child.name,
                        type: child.type,
                        x: child.x,
                        y: child.y,
                        width: child.width,
                        height: child.height,
                        styles: child.styles,
                        customProps: child.customProps || {},
                        children: [],
                        src: compRes.id,
                        fileName: compRes.name + '.xml',
                        asComponent: true,
                        visible: child.visible,
                        overrides: this.extractOverrides(child)
                    };

                    const activePage = this.extractInstanceActiveState(child);
                    if (activePage > 0) {
                        refNode.overrides = refNode.overrides || {};
                        refNode.overrides['page'] = activePage;
                    }

                    node.children[i] = refNode;
                }
            } else {
                this.transformTreeRecursive(child);
            }
        }
    }

    private analyzeMultiLooks(canonical: UINode, instances: UINode[]) {
        if (instances.length <= 1) return;

        // 💡 SSR Strategy: Instead of diffing styles and re-rendering locally,
        // we record each instance's sourceId so the ImagePipeline can request
        // separate SSR renders for each visual state.

        // --- 阶段 A：计算视觉指纹，按外观分组 ---
        const fingerprints = instances.map(inst => this.computeVisualFingerprint(inst));
        const canonicalFP = fingerprints[0];

        // 按指纹分组
        const fpGroups = new Map<string, UINode[]>();
        instances.forEach((inst, i) => {
            const fp = fingerprints[i];
            if (!fpGroups.has(fp)) fpGroups.set(fp, []);
            fpGroups.get(fp)!.push(inst);
        });

        const hasVisualVariants = fpGroups.size > 1;

        if (hasVisualVariants) {
            // --- 阶段 B：视觉差异驱动的 multiLooks ---
            // 多个视觉变体（如不同颜色的按钮背景），为每个独特变体创建 SSR 图片
            console.log(`🎨 [MultiLooks] Found ${fpGroups.size} visual variants for "${canonical.name}" across ${instances.length} instances`);

            let nextPageId = 1;
            const usedPageIds = new Set<number>([0]); // 0 已被默认变体占用

            for (const [fp, group] of fpGroups.entries()) {
                if (fp === canonicalFP) {
                    // 默认变体 (pageId 0)：标记实例为 normal
                    group.forEach(inst => { inst._variantPageId = 0; });
                    continue;
                }

                // 尝试用名称关键词确定语义化的 pageId
                // 💡 如果该 pageId 已被其他变体占用，回退到顺序分配
                let pageId = nextPageId++;
                const nameBasedPage = this.extractInstanceActiveState(group[0]);
                if (nameBasedPage > 0 && !usedPageIds.has(nameBasedPage)) {
                    pageId = nameBasedPage;
                }
                // 确保 pageId 唯一
                while (usedPageIds.has(pageId)) {
                    pageId = nextPageId++;
                }
                usedPageIds.add(pageId);

                // Record multiLook variant
                canonical.multiLooks = canonical.multiLooks || {};
                canonical.multiLooks[pageId] = { sourceId: group[0].sourceId || group[0].id };

                // 标记该组所有实例的 pageId
                group.forEach(inst => { inst._variantPageId = pageId; });

                console.log(`   → Variant pageId=${pageId} from instance "${group[0].name}" (sourceId: ${group[0].sourceId || group[0].id})`);
            }

            // Ensure gearIcon gear exists
            canonical.gears = canonical.gears || [];
            if (!canonical.gears.find(g => g.type === 'gearIcon')) {
                canonical.gears.push({
                    type: 'gearIcon',
                    controller: (canonical.extention === 'Button' || canonical.type === ObjectType.Button) ? 'button' : 'state'
                });
            }
        } else {
            // --- 阶段 C：所有实例视觉一致，回退到名称关键词检测 ---
            instances.forEach((inst) => {
                const pageId = this.extractInstanceActiveState(inst);
                if (pageId === 0) return; // Skip "normal" state (canonical is normal)

                canonical.multiLooks = canonical.multiLooks || {};
                canonical.multiLooks[pageId] = { sourceId: inst.sourceId || inst.id };

                canonical.gears = canonical.gears || [];
                if (!canonical.gears.find(g => g.type === 'gearIcon')) {
                    canonical.gears.push({
                        type: 'gearIcon',
                        controller: (canonical.extention === 'Button' || canonical.type === ObjectType.Button) ? 'button' : 'state'
                    });
                }
            });
        }
    }

    /**
     * 计算节点子树的视觉指纹（填充色 + 描边色），用于区分同结构但不同颜色的实例。
     * 忽略文本内容差异，仅关注视觉属性。
     */
    private computeVisualFingerprint(node: UINode): string {
        const parts: string[] = [];
        const collectColors = (curr: UINode) => {
            if (curr.styles.fillColor && curr.styles.fillColor !== 'transparent') {
                parts.push(curr.name + ':fill:' + curr.styles.fillColor);
            }
            if (curr.styles.strokeColor) {
                parts.push(curr.name + ':stroke:' + curr.styles.strokeColor);
            }
            if (curr.children) curr.children.forEach(collectColors);
        };
        if (node.children) node.children.forEach(collectColors);
        return parts.join('|');
    }

    private computeStyleDiff(node1: UINode, node2: UINode): any {
        const diff: any = {};
        const keys = ['fillColor', 'fillOpacity', 'strokeColor', 'strokeSize', 'gradient', 'imageFill', 'fillType'];
        keys.forEach(k => {
            const v1 = JSON.stringify(node1.styles[k]);
            const v2 = JSON.stringify(node2.styles[k]);
            if (v1 !== v2) diff[k] = node2.styles[k];
        });
        if (JSON.stringify(node1.styles.filters) !== JSON.stringify(node2.styles.filters)) {
            diff.filters = node2.styles.filters;
        }

        // Verbose Debug
        if (node1.name.includes("BtnBg")) {
            // console.log(`🔍 Diffing ${node1.name}: paths1=${node1.customProps?.mergedPaths?.length}, paths2=${node2.customProps?.mergedPaths?.length}`);
        }

        // 💡 Specialized check for Merged Paths (Vector Groups)
        if (node1.customProps?.mergedPaths && node2.customProps?.mergedPaths) {
            const p1 = node1.customProps.mergedPaths[0];
            const p2 = node2.customProps.mergedPaths[0];
            
            // Check Fill Color
            if (p1 && p2 && p1.fillColor !== p2.fillColor) {
                console.log(`🎨 [StyleDiff] Color changed in merged paths for ${node1.name}: ${p1.fillColor} -> ${p2.fillColor}`);
                diff['fillColor'] = p2.fillColor; 
            }
            // Check Stroke Color - ALSO crucial for the Outline/Blue button case
            if (p1 && p2 && p1.strokeColor !== p2.strokeColor) {
                console.log(`🎨 [StyleDiff] Stroke changed in merged paths for ${node1.name}: ${p1.strokeColor} -> ${p2.strokeColor}`);
                diff['strokeColor'] = p2.strokeColor;
            }
        }

        // 💡 Specialized check for Merged Paths (Vector Groups)
        // If the nodes have mergedPaths, we need to check if the internal colors changed.
        // We'll peek at the first path's color as a heuristic.
        if (node1.customProps?.mergedPaths && node2.customProps?.mergedPaths) {
            const p1 = node1.customProps.mergedPaths[0];
            const p2 = node2.customProps.mergedPaths[0];
            if (p1 && p2 && p1.fillColor !== p2.fillColor) {
                console.log(`🎨 [StyleDiff] Color changed in merged paths for ${node1.name}: ${p1.fillColor} -> ${p2.fillColor}`);
                diff['fillColor'] = p2.fillColor; 
            }
        }

        return diff;
    }

    private extractOverrides(node: UINode): Record<string, any> {
        const overrides: Record<string, any> = {};
        
        // 递归查找子节点中的差异内容
        const findChanges = (curr: UINode) => {
            // 如果节点名包含 'Label' 或 'title'，我们记录其文字覆盖
            if (curr.type === ObjectType.Text && curr.text) {
                const nl = curr.name.toLowerCase();
                if (nl.includes('label') || nl.includes('title') || nl.includes('文本') || nl.includes('数值')) {
                    overrides['title'] = curr.text;
                }
            }
            
            // 如果节点名包含 'Icon' 或 'Image'，记录其图片覆盖
            if ((curr.type === ObjectType.Image || curr.type === ObjectType.Loader) && curr.src) {
                const nl = curr.name.toLowerCase();
                if (nl.includes('icon') || nl.includes('image') || nl.includes('图标') || nl.includes('bg') || nl.includes('background')) {
                    overrides['icon'] = curr.src;
                }
            }

            if (curr.children) curr.children.forEach(findChanges);
        };

        findChanges(node);
        return overrides;
    }



    private calculateStructuralHash(node: UINode): string {
        // 深度去重核心逻辑：只关注“结构”和“样式类”，忽略“具体内容”
        // 这样 5 个文字不同的按钮会被识别为同一个组件
        const parts: any[] = [];
        
        // 1. 物理属性 (尺寸是结构的一部分)
        parts.push(node.type, node.width, node.height);
        
        // 2. 视觉样式 - 忽略颜色以便将不同颜色的实例分组到同一组件中进行 Multi-Look 比较
        // 边框宽度、圆角、阴影是组件结构的核心，颜色差异将作为 Multi-Look 变体处理
        const importantStyles = ['borderRadius', 'border', 'strokeSize', 'shadow', 'fillType'];
        importantStyles.forEach(k => {
            if (node.styles[k]) parts.push(k, JSON.stringify(node.styles[k]));
        });
        
        // 💡 关键：忽略 node.text 和 node.src (具体内容)
        
        // 3. 子节点结构 (递归)
        if (node.children && node.children.length > 0) {
            node.children.forEach(c => parts.push(this.calculateStructuralHash(c)));
        }

        return JSON.stringify(parts);
    }

    private stripParent(node: UINode): UINode {
        const { parent, ...rest } = node;
        const newNode: UINode = { ...rest, children: [] };
        if (node.children) {
            newNode.children = node.children.map(c => this.stripParent(c));
        }
        return newNode;
    }

    public applyStandardNaming(node: UINode) {
        const scan = (curr: UINode) => {
            const nameLow = curr.name.toLowerCase();

            // 1. Text -> title
            if (curr.type === ObjectType.Text) {
                if (nameLow.includes('label') || nameLow.includes('title') || nameLow.includes('文本') || nameLow.includes('数值')) {
                    curr.name = 'title';
                }
            }

            // 2. Image/Graph/Component -> icon (convert to Loader)
            const isVisual = (curr.type === ObjectType.Image || curr.type === ObjectType.Graph || curr.type === ObjectType.Component);
            if (isVisual) {
                if (nameLow.includes('icon') || nameLow.includes('image') || nameLow.includes('图标') || nameLow.includes('bg') || nameLow.includes('background')) {
                    // 💡 Only convert to Loader if it's a leaf node, explicit Image, or has assigned resource.
                    // If it's a container (has children) and no resource, we must traverse children for visuals.
                    if ((!curr.children || curr.children.length === 0) || curr.src || curr.type === ObjectType.Image) {
                        curr.name = 'icon';
                        curr.type = ObjectType.Loader;
                    }
                }
            }

            // 3. ProgressBar/Slider specific: Bar & Grip
            if (node.type === ObjectType.ProgressBar || node.type === ObjectType.Slider) {
                if (nameLow.includes('bar') || nameLow.includes('progress') || nameLow.includes('进度')) {
                    curr.name = 'bar';
                }
                if (nameLow.includes('grip') || nameLow.includes('thumb') || nameLow.includes('滑块')) {
                    curr.name = 'grip';
                }
            }

            if (curr.children) curr.children.forEach(scan);
        };
        
        if (node.children) node.children.forEach(scan);
    }

    /**
     * Heuristic: Identify states based on layer names and apply FGUI Controllers/Gears.
     */
    private detectAndApplyStates(node: UINode) {
        const stateKeywords = {
            'selected': ['selected', '选中', 'checked'],
            'over': ['over', 'hover', '悬停'],
            'down': ['down', 'pressed', '按下', 'clicked'],
            'disabled': ['disabled', '禁用', 'grayed'],
            'normal': ['normal', 'up', '普通', '默认']
        };

        const foundStates: Set<string> = new Set();
        const stateNodes: Map<string, UINode[]> = new Map();

        const scan = (curr: UINode) => {
            const nl = curr.name.toLowerCase();
            let matched = false;
            for (const [state, keywords] of Object.entries(stateKeywords)) {
                if (keywords.some(k => nl.includes(k))) {
                    foundStates.add(state);
                    if (!stateNodes.has(state)) stateNodes.set(state, []);
                    stateNodes.get(state)!.push(curr);
                    matched = true;
                    // Don't break, allow multiple (though rare)
                }
            }
            if (curr.children) curr.children.forEach(scan);
        };

        if (node.children) node.children.forEach(scan);

        if (foundStates.size > 0) {
            console.log(`🎭 [State Detection] Detected nodes for states in ${node.name}: ${Array.from(foundStates).join(', ')}`);
            
            // 1. Create Controller
            node.controllers = node.controllers || [];
            const isButton = node.extention === 'Button' || node.type === ObjectType.Button;
            const controllerName = isButton ? 'button' : 'state';
            
            if (isButton) {
                node.controllers.push({
                    name: 'button',
                    pages: "0,up,1,down,2,over,3,selectedOver"
                });
            } else {
                let pageStr = "0,Normal";
                let i = 1;
                const stateList = Array.from(foundStates).filter(s => s !== 'normal');
                stateList.forEach(s => {
                    pageStr += `,${i++},${s}`;
                });
                node.controllers.push({ name: 'state', pages: pageStr });
            }

            // 2. Apply Gears to state nodes
            stateNodes.forEach((nodes, state) => {
                let pageIds = "";
                if (isButton) {
                    if (state === 'down') pageIds = "1";
                    else if (state === 'over') pageIds = "2";
                    else if (state === 'selected') pageIds = "3";
                    else if (state === 'disabled') pageIds = "4";
                    else if (state === 'normal') pageIds = "0"; // Only show on 'up'
                } else {
                    const stateList = Array.from(foundStates).filter(s => s !== 'normal');
                    const idx = stateList.indexOf(state);
                    pageIds = (idx !== -1) ? (idx + 1).toString() : "0";
                }

                // 💡 禁用自动 gearDisplay：
                // 由于 multiLooks 通过 gearIcon 处理状态切换，不需要基于名称的 gearDisplay。
                // 如 "Selected" 层通常是始终可见的装饰层，不应隐藏。
                // 如果需要特定层仅在某些状态显示，应在 Figma 中通过实际的可见性差异来触发，
                // 而不是仅基于命名。
                /*
                if (pageIds !== "") {
                    nodes.forEach(n => {
                        // 💡 如果节点已有 multiLooks，它通过 gearIcon 切换，不需要 gearDisplay
                        if (n.multiLooks && Object.keys(n.multiLooks).length > 0) {
                            return; // Skip - uses gearIcon instead
                        }
                        n.gears = n.gears || [];
                        n.gears.push({
                            type: 'gearDisplay',
                            controller: controllerName,
                            pages: pageIds
                        });
                    });
                }
                */
            });

            // 3. 💡 Pragmatic Default: If we found a 'Selected' or 'Over' node but NO 'Normal' node, 
            // the existing nodes (like Background) might be intended for 'Normal' state.
            // However, FGUI is additive by default, so we usually leave the shared background alone.
        }
    }

    /**
     * Determines which controller page an instance should show.
     * Priority:
     *  1. 视觉变体检测分配的 _variantPageId (from analyzeMultiLooks)
     *  2. 名称关键词检测 (fallback)
     */
    private extractInstanceActiveState(instanceNode: UINode): number {
        // 💡 优先使用视觉变体检测结果
        if (instanceNode._variantPageId !== undefined) {
            return instanceNode._variantPageId;
        }

        const stateKeywords = {
            'selected': ['selected', '选中', 'checked'],
            'over': ['over', 'hover', '悬停'],
            'down': ['down', 'pressed', '按下', 'clicked'],
            'disabled': ['disabled', '禁用', 'grayed']
        };

        // Standard Button Mapping (0:up, 1:down, 2:over, 3:selectedOver)
        const buttonPageMap: Record<string, number> = {
            'selected': 3,
            'over': 2,
            'down': 1,
            'disabled': 4
        };

        const findVisibleState = (curr: UINode): string | null => {
            if (curr.visible !== false) {
                const nl = curr.name.toLowerCase();
                for (const [state, keywords] of Object.entries(stateKeywords)) {
                    if (keywords.some(k => nl.includes(k))) return state;
                }
            }
            if (curr.children) {
                for (const c of curr.children) {
                    const s = findVisibleState(c);
                    if (s) return s;
                }
            }
            return null;
        };

        const state = findVisibleState(instanceNode);
        if (state && buttonPageMap[state] !== undefined) return buttonPageMap[state];
        return 0; 
    }
}
