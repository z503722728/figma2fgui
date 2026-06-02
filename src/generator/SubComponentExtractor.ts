import { UINode, ResourceInfo } from "../models/UINode";
import { ObjectType } from "../models/FGUIEnum";
import { Rules, isExcludedFromExtraction, matchStandardName } from "../rules/RuleLoader";

/**
 * SubComponentExtractor: 遍历 UINode 树，将容器提取为独立 FGUI 子组件。
 *
 * 改进（design2fgui）：
 * - 组件提取排除规则从 rules/exclude-names.json 读取，不再写死 "btntext"。
 * - applyStandardNaming 从 rules/naming-map.json 读取角色映射，不再写死关键词。
 * - minChildrenToExtract 从 rules/pipeline-config.json 读取，不再写死 2。
 */
export class SubComponentExtractor {
    private _newResources: ResourceInfo[] = [];
    private _nextCompId = 0;
    private _componentCache = new Map<string, ResourceInfo>();
    private _candidateGroups = new Map<string, UINode[]>();
    private _minChildren: number;

    constructor() {
        try {
            this._minChildren = Rules.pipeline().componentExtraction.minChildrenToExtract;
        } catch {
            this._minChildren = 2;
        }
    }

    public extract(rootNodes: UINode[]): ResourceInfo[] {
        this._newResources = [];
        this._nextCompId = 0;
        this._componentCache.clear();
        this._candidateGroups.clear();

        for (const root of rootNodes) {
            this.collectCandidatesRecursive(root);
        }

        const usedNames = new Map<string, number>();
        for (const [hash, instances] of this._candidateGroups.entries()) {
            if (instances.length === 0) continue;
            const canonical = instances[0];

            const resId = `comp_` + (this._nextCompId++);
            let safeName = canonical.name.replace(/\s+/g, '');

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
                data: ""
            };
            this._componentCache.set(hash, preRes);
            this.analyzeMultiLooks(canonical, instances);
        }

        for (const group of this._candidateGroups.values()) {
            for (const inst of group) {
                this.transformTreeRecursive(inst);
                this.detectAndApplyStates(inst);
            }
        }
        for (const root of rootNodes) {
            this.transformTreeRecursive(root);
            this.detectAndApplyStates(root);
        }

        for (const [hash, instances] of this._candidateGroups.entries()) {
            const canonical = instances[0];
            const cachedRes = this._componentCache.get(hash)!;
            const cleanNode = this.stripParent(canonical);

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

            // ─── 组件级 multiLooks 分发 ──────────────────────────────────────────
            // Check Button 已在 analyzeMultiLooks 阶段将 multiLooks 下移到各子节点，
            // cleanNode.multiLooks 此时为空，直接跳过。
            // 普通 Button / Label 等：multiLooks 在组件级，分发给 icon 或 bar 子节点。
            if (cleanNode.multiLooks && cleanNode.children) {
                const isCheckBtn = cleanNode.buttonMode === 'Check' || cleanNode.buttonMode === 'Radio';
                const variantChild = isCheckBtn
                    ? (cleanNode.children.find(c => c.name === 'bar') || cleanNode.children.find(c => c.name === 'icon'))
                    : cleanNode.children.find(c => c.name === 'icon');

                if (variantChild) {
                    const variantIdx = cleanNode.children.indexOf(variantChild);
                    const resolvedLooks: Record<string, any> = {};
                    for (const [pid, look] of Object.entries(cleanNode.multiLooks as Record<string, any>)) {
                        const instChild = look.instanceChildren?.[variantIdx];
                        resolvedLooks[pid] = {
                            sourceId: instChild
                                ? (instChild.sourceId || instChild.id)
                                : look.sourceId
                        };
                    }
                    variantChild.multiLooks = resolvedLooks;
                    const gearIcons = (cleanNode.gears || []).filter(g => g.type === 'gearIcon');
                    if (gearIcons.length > 0) {
                        variantChild.gears = (variantChild.gears || []).concat(gearIcons);
                    }
                    delete cleanNode.multiLooks;
                    cleanNode.gears = (cleanNode.gears || []).filter(g => g.type !== 'gearIcon');
                }
            }

            // ─── List 组件：提取 item template 为独立组件 ─────────────────────────
            // AI 通过 list_item_template 指定模板名称；如果没有则取第一个子节点。
            // 提取后 List 自身不再展开子节点，由 defaultItem 引用 template。
            if (cleanNode.extention === 'List' && cleanNode.children?.length) {
                const templateName = (cleanNode as any)._listItemTemplateName;

                // 优先从全局组件缓存里按名称查找已提取的 template（如 GachaItem）
                let foundInCache: ResourceInfo | undefined;
                if (templateName) {
                    for (const res of this._newResources) {
                        if (res.name === templateName) { foundInCache = res; break; }
                    }
                }

                if (foundInCache) {
                    cleanNode.listItemTemplate = foundInCache.id;
                    console.log(`📋 List "${cleanNode.name}" → 全局 template: "${foundInCache.name}" (${foundInCache.id})`);
                } else {
                    // 回退：在直接子节点里找（按名称，否则取第一个）
                    const templateChild = templateName
                        ? (cleanNode.children.find(c => c.name === templateName) || cleanNode.children[0])
                        : cleanNode.children[0];

                    if (templateChild) {
                        const templateHash = this.calculateStructuralHash(templateChild);
                        const existingRes = this._componentCache.get(templateHash);
                        if (existingRes) {
                            cleanNode.listItemTemplate = existingRes.id;
                            console.log(`📋 List "${cleanNode.name}" → 复用 template: "${existingRes.name}"`);
                        } else {
                            const templateResId = `comp_tmpl_${this._nextCompId++}`;
                            const safeName = (templateName || templateChild.name).replace(/\s+/g, '');
                            const strippedTemplate = this.stripParent(templateChild);
                            const templateRes: ResourceInfo = {
                                id: templateResId,
                                name: safeName,
                                type: 'component',
                                data: JSON.stringify({ ...strippedTemplate, _isListItem: true })
                            };
                            this._componentCache.set(templateHash, templateRes);
                            this._newResources.push(templateRes);
                            cleanNode.listItemTemplate = templateResId;
                            console.log(`📋 List "${cleanNode.name}" → 新 template: "${safeName}" (${templateResId})`);
                        }
                    }
                }
                cleanNode.children = [];
            }

            cachedRes.data = JSON.stringify(cleanNode);
            this._newResources.push(cachedRes);
        }

        return this._newResources;
    }

    private collectCandidatesRecursive(node: UINode): void {
        if (node.visible === false) {
            const nameLow = node.name.toLowerCase();
            const stateKeywords = ['hover', 'pressed', 'down', 'selected', 'checked', 'disabled', '悬停', '按下', '选中'];
            if (!stateKeywords.some(k => nameLow.includes(k))) return;
        }

        if (!node.children || node.children.length === 0) return;
        for (const child of node.children) {
            this.collectCandidatesRecursive(child);
        }

        // 扩展类型（Button/Label 等）即使子节点全是形状，也必须提取为组件。
        // 例如 Toggle 开关内部含 Rectangle（轨道）+ Ellipse（滑块），
        // 虽然全是形状，但需要作为可交互的 Check Button 组件处理。
        const isExtensionType = (
            node.type === ObjectType.Button ||
            node.type === ObjectType.Label ||
            node.type === ObjectType.ProgressBar ||
            node.type === ObjectType.Slider ||
            node.type === ObjectType.ComboBox ||
            node.type === ObjectType.List
        );

        // 纯形状组：只有非扩展类型才跳过提取（让 SSR 整体渲染）
        // 例外：AI 明确标注了 semanticType 的节点（如 GachaItem），即使全是形状也要提取为独立组件
        const hasSemanticTag = !!(node as any).semanticType;
        if (!isExtensionType && !hasSemanticTag && this.allDescendantsAreShapes(node)) return;

        if (!isExtensionType && !hasSemanticTag && this.hasMaskDescendants(node)) return;

        const hasNestedExtracted = node.children.some(c => c.asComponent);
        const hasVisuals = (node.styles.background || node.styles.backgroundColor || node.styles.border || node.styles.outline);

        const isSignificant = node.children.length > this._minChildren ||
            isExtensionType ||
            hasNestedExtracted ||
            (hasVisuals && node.children.length > 0);

        // 排除列表从 rules/exclude-names.json 读取（不再写死 "btntext"）
        if (isExcludedFromExtraction(node.name)) return;

        if (isSignificant) {
            // Check/Radio Button：忽略颜色差异，用结构哈希合并开/关状态实例
            const isCheckOrRadio = isExtensionType &&
                node.type === ObjectType.Button &&
                (node.buttonMode === 'Check' || node.buttonMode === 'Radio');
            let hash = this.calculateStructuralHash(node, isCheckOrRadio);

            // 💡 AI 明确标注了语义名称（fgui_name/semanticType）的节点，
            // 将名称加入哈希，防止不同名称的同结构组件被错误合并。
            // 例如：Btn_ArrowLeft 与 Btn_ArrowRight 结构相同但语义不同，必须各自独立生成。
            if ((node as any).semanticType && node.name) {
                hash = JSON.stringify([node.name, hash]);
            }

            if (!this._candidateGroups.has(hash)) {
                this._candidateGroups.set(hash, []);
            }
            this._candidateGroups.get(hash)!.push(node);
            node.asComponent = true;
            node._structuralHash = hash;
        }
    }

    private hasMaskDescendants(node: UINode): boolean {
        if (!node.children) return false;
        for (const child of node.children) {
            if (child.customProps?.isMask) return true;
            if (this.hasMaskDescendants(child)) return true;
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
            if (!this.allDescendantsAreShapes(child)) return false;
        }
        return true;
    }

    private transformTreeRecursive(node: UINode): void {
        if (!node.children) return;
        for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            if (child.asComponent) {
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

        // ─── Check / Radio Button 专用 ────────────────────────────────────────────
        if (canonical.buttonMode === 'Check' || canonical.buttonMode === 'Radio') {
            const fingerprints = instances.map(inst => this.computeVisualFingerprint(inst));
            const canonicalFP = fingerprints[0];
            const fpGroups = new Map<string, UINode[]>();
            instances.forEach((inst, i) => {
                const fp = fingerprints[i];
                if (!fpGroups.has(fp)) fpGroups.set(fp, []);
                fpGroups.get(fp)!.push(inst);
            });

            if (fpGroups.size > 1) {
                console.log(`🔘 [CheckButton] "${canonical.name}" 找到 ${fpGroups.size} 种视觉状态`);

                // 找到 OFF(canonical) 和 ON(另一批) 两组
                let onInstance: UINode | null = null;
                let pageId = 1;
                for (const [fp, group] of fpGroups.entries()) {
                    if (fp === canonicalFP) {
                        group.forEach(inst => { inst._variantPageId = 0; });
                        continue;
                    }
                    canonical.multiLooks = canonical.multiLooks || {};
                    canonical.multiLooks[pageId] = {
                        sourceId: group[0].sourceId || group[0].id,
                        instanceChildren: group[0].children,
                    };
                    if (pageId === 1) onInstance = group[0];
                    group.forEach(inst => { inst._variantPageId = pageId; });
                    console.log(`   → pageId=${pageId} (on) from "${group[0].name}"`);
                    pageId++;
                }

                // ─── 逐子节点决策：换图 vs 显隐 ──────────────────────────────────
                // 对比 OFF（canonical.children）和 ON（onInstance.children）每个子节点：
                //   位置+尺寸相同 → gearIcon 换图（单张 loader）
                //   位置或尺寸不同 → gearDisplay 显隐（OFF图pages="0,2"，ON图pages="1,3"）
                //
                // 关键：先快照原始子节点列表，splice 插入的 onMirror 不被遍历
                const offChildren = [...(canonical.children || [])];  // 快照
                const onChildren  = onInstance?.children || [];
                const insertions: Array<{ afterIndex: number; node: UINode }> = [];

                for (let i = 0; i < offChildren.length; i++) {
                    const offChild = offChildren[i];
                    const onChild  = onChildren[i];
                    if (!onChild) continue;

                    // grip 节点：有子节点（Ellipse + Frame_62），标记整体合并
                    if (offChild.name === 'grip' && offChild.children?.length) {
                        (offChild as any)._mergeWithParent = true;
                    }

                    const samePos  = offChild.x === onChild.x && offChild.y === onChild.y;
                    const sameSize = offChild.width === onChild.width && offChild.height === onChild.height;

                    if (samePos && sameSize) {
                        // 位置+尺寸完全相同 → gearIcon 换图
                        console.log(`   → child[${i}] "${offChild.name}": 位置尺寸相同 → gearIcon 换图`);
                        offChild.gears = offChild.gears || [];
                        if (!offChild.gears.find(g => g.type === 'gearIcon')) {
                            offChild.gears.push({ type: 'gearIcon', controller: 'button' });
                        }
                        offChild.multiLooks = { [1]: { sourceId: onChild.sourceId || onChild.id } };
                    } else {
                        // 位置或尺寸不同 → gearDisplay 显隐
                        console.log(`   → child[${i}] "${offChild.name}": 位置/尺寸不同 → gearDisplay 显隐`);
                        offChild.gears = offChild.gears || [];
                        offChild.gears.push({ type: 'gearDisplay', controller: 'button', pages: '0,2' });

                        // ON 镜像节点（用 onChild 的 sourceId 下载图片，用 onChild 的坐标显示）
                        const onMirror: UINode = {
                            ...offChild,
                            id:         offChild.id + '_on',
                            sourceId:   onChild.sourceId || onChild.id,
                            name:       offChild.name + '_on',
                            x:          onChild.x,
                            y:          onChild.y,
                            width:      onChild.width,
                            height:     onChild.height,
                            children:   [],
                            multiLooks: undefined,
                            gears:      [{ type: 'gearDisplay', controller: 'button', pages: '1,3' }],
                            src:        undefined,
                            fileName:   undefined,
                        };
                        insertions.push({ afterIndex: i, node: onMirror });
                    }
                }

                // 按倒序插入（保证前面插入不影响后面的索引）
                for (let k = insertions.length - 1; k >= 0; k--) {
                    const { afterIndex, node: mirrorNode } = insertions[k];
                    canonical.children!.splice(afterIndex + 1, 0, mirrorNode);
                }

                // 清除组件级别的 multiLooks（已下移到子节点）
                delete canonical.multiLooks;
                canonical.gears = (canonical.gears || []).filter(g => g.type !== 'gearIcon');
                canonical.controllers = (canonical.controllers || []).filter((c: any) => c.name !== 'selected');
            }
            return;
        }

        // ─── 普通多外观处理（原有逻辑） ──────────────────────────────────────────
        const fingerprints = instances.map(inst => this.computeVisualFingerprint(inst));
        const canonicalFP = fingerprints[0];
        const fpGroups = new Map<string, UINode[]>();
        instances.forEach((inst, i) => {
            const fp = fingerprints[i];
            if (!fpGroups.has(fp)) fpGroups.set(fp, []);
            fpGroups.get(fp)!.push(inst);
        });

        const hasVisualVariants = fpGroups.size > 1;

        if (hasVisualVariants) {
            console.log(`🎨 [MultiLooks] Found ${fpGroups.size} visual variants for "${canonical.name}" across ${instances.length} instances`);
            let nextPageId = 1;
            const usedPageIds = new Set<number>([0]);

            for (const [fp, group] of fpGroups.entries()) {
                if (fp === canonicalFP) {
                    group.forEach(inst => { inst._variantPageId = 0; });
                    continue;
                }
                let pageId = nextPageId++;
                const nameBasedPage = this.extractInstanceActiveState(group[0]);
                if (nameBasedPage > 0 && !usedPageIds.has(nameBasedPage)) pageId = nameBasedPage;
                while (usedPageIds.has(pageId)) pageId = nextPageId++;
                usedPageIds.add(pageId);

                canonical.multiLooks = canonical.multiLooks || {};
                canonical.multiLooks[pageId] = {
                    sourceId: group[0].sourceId || group[0].id,
                    instanceChildren: group[0].children,
                };
                group.forEach(inst => { inst._variantPageId = pageId; });
                console.log(`   → Variant pageId=${pageId} from instance "${group[0].name}" (sourceId: ${group[0].sourceId || group[0].id})`);
            }

            canonical.gears = canonical.gears || [];
            if (!canonical.gears.find(g => g.type === 'gearIcon')) {
                canonical.gears.push({
                    type: 'gearIcon',
                    controller: (canonical.extention === 'Button' || canonical.type === ObjectType.Button) ? 'button' : 'state'
                });
            }
        } else {
            instances.forEach((inst) => {
                const pageId = this.extractInstanceActiveState(inst);
                if (pageId === 0) return;
                canonical.multiLooks = canonical.multiLooks || {};
                canonical.multiLooks[pageId] = {
                    sourceId: inst.sourceId || inst.id,
                    instanceChildren: inst.children,
                };
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

    private computeVisualFingerprint(node: UINode): string {
        const parts: string[] = [];
        const collectColors = (curr: UINode) => {
            if (curr.styles.fillColor && curr.styles.fillColor !== 'transparent') parts.push(curr.name + ':fill:' + curr.styles.fillColor);
            if (curr.styles.strokeColor) parts.push(curr.name + ':stroke:' + curr.styles.strokeColor);
            if (curr.children) curr.children.forEach(collectColors);
        };
        if (node.children) node.children.forEach(collectColors);
        return parts.join('|');
    }

    private extractOverrides(node: UINode): Record<string, any> {
        const overrides: Record<string, any> = {};
        const findChanges = (curr: UINode) => {
            if (curr.type === ObjectType.Text && curr.text) {
                const nl = curr.name.toLowerCase();
                if (nl.includes('label') || nl.includes('title') || nl.includes('文本') || nl.includes('数值')) {
                    overrides['title'] = curr.text;
                }
            }
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

    private calculateStructuralHash(node: UINode, ignoreColor = false): string {
        const parts: any[] = [];

        if (!ignoreColor) {
            // 默认模式：精确哈希（type + size + 关键样式 + 子节点递归）
            parts.push(node.type, node.width, node.height);
            const importantStyles = ['borderRadius', 'border', 'strokeSize', 'shadow', 'fillType'];
            importantStyles.forEach(k => {
                if (node.styles[k]) parts.push(k, JSON.stringify(node.styles[k]));
            });
            if (node.children?.length > 0) {
                node.children.forEach(c => parts.push(this.calculateStructuralHash(c, false)));
            }
        } else {
            // 结构模式（Check/Radio Button 合并开/关状态实例）：
            // 只比较「节点类型树」，忽略颜色、尺寸、坐标差异。
            // 例如 Toggle 开/关状态：bar 宽度不同、颜色不同，但类型树相同（Button → [Image, Image, Frame]）。
            parts.push(node.type);
            parts.push(node.children?.length ?? 0); // 只比较子节点数量
            if (node.children?.length > 0) {
                node.children.forEach(c => parts.push(this.calculateStructuralHash(c, true)));
            }
        }

        return JSON.stringify(parts);
    }



    private stripParent(node: UINode): UINode {
        const { parent, ...rest } = node;
        const newNode: UINode = { ...rest, children: [] };
        if (node.children) newNode.children = node.children.map(c => this.stripParent(c));
        return newNode;
    }

    /**
     * 将子节点重命名为 FGUI 标准角色名称。
     *
     * 改进：优先读取 node.childrenRoles（AI 标注），
     * 降级到 rules/naming-map.json 关键词匹配。
     */
    public applyStandardNaming(node: UINode) {
        const parentTypeName = ObjectType[node.type] as string;

        const scan = (curr: UINode) => {
            const currTypeName = ObjectType[curr.type] as string;

            // 1. AI 标注的角色优先（childrenRoles: { nodeId → stdName }）
            const aiRole = node.childrenRoles?.[curr.sourceId || curr.id]
                ?? node.childrenRoles?.[curr.id];
            if (aiRole) {
                console.log(`🤖 AI角色: "${curr.name}" → "${aiRole}"`);
                curr.name = aiRole;
                if (aiRole === 'icon') curr.type = ObjectType.Loader;
                if (curr.children) curr.children.forEach(scan);
                return;
            }

            // 2. 规则文件匹配
            const stdName = matchStandardName(curr.name, currTypeName, parentTypeName);
            if (stdName) {
                curr.name = stdName;
                // naming-map.json 中 convertToLoader: true 的条目自动转为 Loader
                try {
                    const entry = Rules.namingMap()[stdName];
                    if (entry?.convertToLoader && (
                        curr.type === ObjectType.Image ||
                        curr.type === ObjectType.Graph ||
                        curr.type === ObjectType.Component
                    )) {
                        if ((!curr.children || curr.children.length === 0) || curr.src || curr.type === ObjectType.Image) {
                            curr.type = ObjectType.Loader;
                        }
                    }
                } catch { /* 规则文件不可用时跳过 */ }
            }

            if (curr.children) curr.children.forEach(scan);
        };

        if (node.children) node.children.forEach(scan);
    }

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
            for (const [state, keywords] of Object.entries(stateKeywords)) {
                if (keywords.some(k => nl.includes(k))) {
                    foundStates.add(state);
                    if (!stateNodes.has(state)) stateNodes.set(state, []);
                    stateNodes.get(state)!.push(curr);
                }
            }
            if (curr.children) curr.children.forEach(scan);
        };

        if (node.children) node.children.forEach(scan);

        if (foundStates.size > 0) {
            console.log(`🎭 [State Detection] Detected states in ${node.name}: ${Array.from(foundStates).join(', ')}`);
            node.controllers = node.controllers || [];
            const isButton = node.extention === 'Button' || node.type === ObjectType.Button;

            if (isButton) {
                node.controllers.push({ name: 'button', pages: "0,up,1,down,2,over,3,selectedOver" });
            } else {
                let pageStr = "0,Normal";
                let i = 1;
                Array.from(foundStates).filter(s => s !== 'normal').forEach(s => {
                    pageStr += `,${i++},${s}`;
                });
                node.controllers.push({ name: 'state', pages: pageStr });
            }
        }
    }

    private extractInstanceActiveState(instanceNode: UINode): number {
        if (instanceNode._variantPageId !== undefined) return instanceNode._variantPageId;

        // 从 rules/button-states.json 读取页面映射
        let buttonPageMap: Record<string, number>;
        try {
            const stateRules = Rules.buttonStates();
            buttonPageMap = {};
            for (const [pageIdx, keywords] of Object.entries(stateRules.pageMap)) {
                const idx = parseInt(pageIdx);
                if (idx === 0) continue; // 0 = normal，不需要映射
                keywords.forEach(kw => { buttonPageMap[kw] = idx; });
            }
        } catch {
            buttonPageMap = { 'selected': 3, 'over': 2, 'down': 1, 'disabled': 4 };
        }

        const stateKeywords = {
            'selected': ['selected', '选中', 'checked'],
            'over': ['over', 'hover', '悬停'],
            'down': ['down', 'pressed', '按下', 'clicked'],
            'disabled': ['disabled', '禁用', 'grayed']
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
