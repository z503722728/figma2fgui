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

            if (cleanNode.multiLooks && cleanNode.children) {
                const iconChild = cleanNode.children.find(c => c.name === 'icon');
                if (iconChild) {
                    const iconIdx = cleanNode.children.indexOf(iconChild);
                    const resolvedLooks: Record<string, any> = {};
                    for (const [pid, look] of Object.entries(cleanNode.multiLooks as Record<string, any>)) {
                        const variantChild = look.instanceChildren?.[iconIdx];
                        resolvedLooks[pid] = {
                            sourceId: variantChild
                                ? (variantChild.sourceId || variantChild.id)
                                : look.sourceId
                        };
                    }
                    iconChild.multiLooks = resolvedLooks;
                    const gearIcons = (cleanNode.gears || []).filter(g => g.type === 'gearIcon');
                    if (gearIcons.length > 0) {
                        iconChild.gears = (iconChild.gears || []).concat(gearIcons);
                    }
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
        if (node.visible === false) {
            const nameLow = node.name.toLowerCase();
            const stateKeywords = ['hover', 'pressed', 'down', 'selected', 'checked', 'disabled', '悬停', '按下', '选中'];
            if (!stateKeywords.some(k => nameLow.includes(k))) return;
        }

        if (!node.children || node.children.length === 0) return;
        for (const child of node.children) {
            this.collectCandidatesRecursive(child);
        }

        if (this.allDescendantsAreShapes(node)) return;

        const isExtensionType = (
            node.type === ObjectType.Button ||
            node.type === ObjectType.Label ||
            node.type === ObjectType.ProgressBar ||
            node.type === ObjectType.Slider ||
            node.type === ObjectType.ComboBox ||
            node.type === ObjectType.List
        );

        if (!isExtensionType && this.hasMaskDescendants(node)) return;

        const hasNestedExtracted = node.children.some(c => c.asComponent);
        const hasVisuals = (node.styles.background || node.styles.backgroundColor || node.styles.border || node.styles.outline);

        const isSignificant = node.children.length > this._minChildren ||
            isExtensionType ||
            hasNestedExtracted ||
            (hasVisuals && node.children.length > 0);

        // 排除列表从 rules/exclude-names.json 读取（不再写死 "btntext"）
        if (isExcludedFromExtraction(node.name)) return;

        if (isSignificant) {
            const hash = this.calculateStructuralHash(node);
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

    private calculateStructuralHash(node: UINode): string {
        const parts: any[] = [];
        parts.push(node.type, node.width, node.height);
        const importantStyles = ['borderRadius', 'border', 'strokeSize', 'shadow', 'fillType'];
        importantStyles.forEach(k => {
            if (node.styles[k]) parts.push(k, JSON.stringify(node.styles[k]));
        });
        if (node.children && node.children.length > 0) {
            node.children.forEach(c => parts.push(this.calculateStructuralHash(c)));
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
