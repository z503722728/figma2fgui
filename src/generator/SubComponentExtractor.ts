import { UINode, ResourceInfo } from "../models/UINode";
import { ObjectType } from "../models/FGUIEnum";

/**
 * SubComponentExtractor: Walks the UINode tree and extracts Containers into proper FGUI Component References.
 */
export class SubComponentExtractor {
    private _newResources: ResourceInfo[] = [];
    private _nextCompId = 0;
    private _componentCache = new Map<string, ResourceInfo>();

    public extract(rootNodes: UINode[]): ResourceInfo[] {
        this._newResources = [];
        this._nextCompId = 0;
        this._componentCache.clear();

        for (const root of rootNodes) {
            this.processNodeRef(root);
        }

        return this._newResources;
    }

    private processNodeRef(node: UINode): void {
        if (!node.children || node.children.length === 0) return;

        // 1. Process children first (Bottom-Up extraction)
        for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            
            if (child.children && child.children.length > 0) {
                this.processNodeRef(child);
            }

            // 2. Evaluate if 'child' should be extracted as a separate component
            if (child.type === ObjectType.Component || child.type === ObjectType.Button) {
                // Heuristic: A node is "Significant" enough to be its own component if:
                // 1. It is a Button (functionally distinct)
                // 2. It has more than 2 children (e.g., a card or complex group)
                // 3. It contains children that were themselves already extracted (nested hierarchy)
                // 4. It has a background/border AND children (Significant visual group)
                
                const hasNestedExtracted = child.children.some(c => c.asComponent);
                const hasVisuals = (child.styles.background || child.styles.backgroundColor || child.styles.border || child.styles.outline);
                
                const isSignificant = child.children.length > 2 || 
                    child.type === ObjectType.Button || 
                    hasNestedExtracted ||
                    (hasVisuals && child.children.length > 0);

                if (isSignificant) {
                    // Extract!
                    const compRes = this.createSubComponentResource(child);
                    // Only add if not already in the list
                    if (!this._newResources.find(r => r.id === compRes.id)) {
                        this._newResources.push(compRes);
                    }

                    // Transform 'child' into a Reference Node
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
                        // 💡 记录覆盖属性 (目前支持文字和图片)
                        overrides: this.extractOverrides(child)
                    };

                    node.children[i] = refNode;
                }
            }
        }
    }

    private extractOverrides(node: UINode): Record<string, any> {
        const overrides: Record<string, any> = {};
        
        // 递归查找子节点中的差异内容
        const findChanges = (curr: UINode) => {
            // 如果节点名包含 'Label' 或 'title'，我们记录其文字覆盖
            if (curr.type === ObjectType.Text && curr.text) {
                if (curr.name.toLowerCase().includes('label') || curr.name.toLowerCase().includes('title')) {
                    overrides['title'] = curr.text;
                }
            }
            
            // 如果节点名包含 'Icon' 或 'Image'，记录其图片覆盖
            if (curr.type === ObjectType.Image && curr.src) {
                if (curr.name.toLowerCase().includes('icon') || curr.name.toLowerCase().includes('image')) {
                    overrides['icon'] = curr.src;
                }
            }

            if (curr.children) curr.children.forEach(findChanges);
        };

        findChanges(node);
        return overrides;
    }

    private createSubComponentResource(node: UINode): ResourceInfo {
        const hash = this.calculateStructuralHash(node);
        
        if (this._componentCache.has(hash)) {
            const cached = this._componentCache.get(hash)!;
            console.log(`♻️ [去重] 检测到重复结构，复用组件: ${cached.name} (原始: ${node.name})`);
            return cached;
        }

        // 使用组件名作为前缀，并分配唯一的资源 ID
        const resId = `comp_` + (this._nextCompId++);
        const safeName = node.name.replace(/\s+/g, '');
        
        const cleanNode = this.stripParent(node);
        
        // 💡 FGUI Button Handling
        if (node.type === ObjectType.Button) {
            cleanNode.extention = 'Button';
            this.applyButtonNaming(cleanNode);
        }

        const compData = JSON.stringify(cleanNode);

        const newRes: ResourceInfo = {
            id: resId,
            name: safeName,
            type: 'component',
            data: compData
        };

        this._componentCache.set(hash, newRes);
        return newRes;
    }

    private calculateStructuralHash(node: UINode): string {
        // 深度去重核心逻辑：只关注“结构”和“样式类”，忽略“具体内容”
        // 这样 5 个文字不同的按钮会被识别为同一个组件
        const parts: any[] = [];
        
        // 1. 物理属性 (尺寸是结构的一部分)
        parts.push(node.type, node.width, node.height);
        
        // 2. 视觉样式 (忽略具体的填充色，如果需要更激进的去重)
        // 但通常边框、圆角、阴影是组件特性的核心，我们保留它们
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

    private applyButtonNaming(node: UINode) {
        const scan = (curr: UINode) => {
            // Text -> title
            if (curr.type === ObjectType.Text) {
                const nameLow = curr.name.toLowerCase();
                if (nameLow.includes('label') || nameLow.includes('title') || nameLow.includes('文本')) {
                    curr.name = 'title';
                }
            }
            // Image/Graph -> icon (convert to Loader)
            if ((curr.type === ObjectType.Image || curr.type === ObjectType.Graph) && !curr.children?.length) {
                const nameLow = curr.name.toLowerCase();
                if (nameLow.includes('icon') || nameLow.includes('image') || nameLow.includes('图标')) {
                    curr.name = 'icon';
                    curr.type = ObjectType.Loader;
                }
            }

            if (curr.children) curr.children.forEach(scan);
        };
        
        // Don't rename the root button node itself, only its children
        if (node.children) node.children.forEach(scan);
    }
}
