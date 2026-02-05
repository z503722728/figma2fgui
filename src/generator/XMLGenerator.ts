import * as xmlbuilder from 'xmlbuilder';
import { UINode, ResourceInfo } from '../models/UINode';
import { ObjectType } from '../models/FGUIEnum';
import { PropertyMapper } from '../mapper/PropertyMapper';

/**
 * XMLGenerator: Responsible for producing valid FGUI XML files.
 */
export class XMLGenerator {
    private _mapper = new PropertyMapper();

    /**
     * Generates component XML from a list of UI nodes.
     * Recursively processes children if present in the 'nodes' tree.
     */
    public generateComponentXml(nodes: UINode[], buildId: string, width: number = 1440, height: number = 1024, rootStyles?: Record<string, any>, extention?: string): string {
        const component = xmlbuilder.create('component').att('size', `${width},${height}`);
        if (extention) component.att('extention', extention);
        const displayList = component.ele('displayList');
        const context = { idCounter: 0 };

        // Automatic Background Injection
        // If the component root has background-color or border, we need a graph to render it
        if (rootStyles) {
            const mapper = new PropertyMapper(); // Using local instance just for easy mapping, or we can manually map
            // Use a temporary node to map attributes
            const testNode: any = { styles: rootStyles, type: ObjectType.Graph, width, height, x: 0, y: 0 };
            const testAttrs = mapper.mapAttributes(testNode, "test");
            
            // Check if we have visual properties
            if (testAttrs.fillColor || (testAttrs.lineColor && testAttrs.lineSize)) {
                const assignedId = `n${context.idCounter++}`;
                const attrs = mapper.mapAttributes({ ...testNode, id: assignedId, name: assignedId }, assignedId);
                // Ensure it fills the component
                attrs.size = `${width},${height}`;
                attrs.xy = "0,0";
                
                // Add to display list FIRST (bottom layer)
                displayList.ele('graph', attrs);
            }
        }

        nodes.forEach(node => {
            this.generateNodeXml(node, displayList, buildId, context);
        });

        return component.end({ pretty: true });
    }

    /**
     * Generates XML for a single node and appends it to the parent XML element.
     */
    private generateNodeXml(node: UINode, parentEle: any, buildId: string, context: { idCounter: number }) {
        let eleName = 'graph';

        // Check if this node is a placeholder for an extracted component
        if (node.asComponent && node.src) {
            const assignedId = `n${context.idCounter++}`;
            const attributes = this._mapper.mapAttributes(node, assignedId);
            
            eleName = 'component';
            attributes.src = node.src;
            if (node.fileName) attributes.fileName = node.fileName;
            
            // Clear other unrelated attributes
            delete attributes.type;
            delete attributes.fillColor;

            const compEle = parentEle.ele(eleName, attributes);
            
            // 💡 写入属性覆盖 (Overrides)
            if (node.overrides) {
                // 如果是按钮类组件，使用 <Button> 标签覆盖
                if (node.type === ObjectType.Button) {
                    const btnAttr: any = {};
                    if (node.overrides.title) btnAttr.title = node.overrides.title;
                    if (node.overrides.icon) {
                        btnAttr.icon = `ui://${buildId}${node.overrides.icon}`;
                    }
                    compEle.ele('Button', btnAttr);
                } else {
                    // 通用自定义属性覆盖
                    Object.keys(node.overrides).forEach(key => {
                        compEle.ele('customData', { [key]: node.overrides![key] });
                    });
                }
            }
            return;
        } else {
            // Standard Mapping
            switch (node.type) {
                case ObjectType.Text:
                    eleName = 'text';
                    break;
                case ObjectType.Image:
                    eleName = 'image';
                    break;
                case ObjectType.Loader:
                    eleName = 'loader';
                    break;
                case ObjectType.InputText:
                    eleName = 'text'; 
                    break;
                case ObjectType.Component:
                case ObjectType.Graph:
                case ObjectType.Group:
                    // If it's a container that wasn't extracted, we flatten its children.
                    const testAttr = this._mapper.mapAttributes(node, "test");
                    const hasVisuals = testAttr.fillColor || (testAttr.lineColor && testAttr.lineSize);
                    const hasChildren = node.children && node.children.length > 0;

                    if (!hasVisuals && !hasChildren) {
                        return; // Prune empty, style-less containers (e.g. <div></div>)
                    }

                    if (hasVisuals) {
                        const assignedId = `n${context.idCounter++}`;
                        const attributes = this._mapper.mapAttributes(node, assignedId);
                        parentEle.ele('graph', attributes);
                    }

                    if (hasChildren) {
                        // FGUI is a flat list per component.
                        // Recursive Flattening: we promote children to the current level, adjusting coordinates.
                        node.children.forEach(child => {
                            const flattenedChild = { ...child };
                            flattenedChild.x = node.x + child.x;
                            flattenedChild.y = node.y + child.y; 
                            this.generateNodeXml(flattenedChild, parentEle, buildId, context);
                        });
                        return; // Children processed
                    }
                    return; 
            }
        }

        const assignedId = `n${context.idCounter++}`;
        const attributes = this._mapper.mapAttributes(node, assignedId);

        // Apply type-specific post-mapping
        if (node.type === ObjectType.Image && node.src) {
            attributes.src = node.src;
            if (node.fileName) attributes.fileName = node.fileName;
            delete attributes.fill;
        } else if (node.type === ObjectType.Loader && node.src) {
            attributes.url = `ui://${buildId}${node.src}`;
        } else if (node.type === ObjectType.InputText) {
            attributes.input = "true";
        }

        parentEle.ele(eleName, attributes);
    }

    /**
     * Generates package.xml description.
     */
    public generatePackageXml(resources: ResourceInfo[], buildId: string, packName: string): string {
        const pkgDesc = xmlbuilder.create('packageDescription').att('id', buildId);
        const resNode = pkgDesc.ele('resources');

        resources.forEach(res => {
            if (res.type === 'misc') return;
            
            const resAttr: any = { 
                id: res.id, 
                name: res.name, 
                path: res.type === 'image' ? '/img/' : '/', 
                exported: res.exported ? 'true' : 'false' 
            };
            
            if (res.type === 'component' && !res.name.endsWith('.xml')) {
                resAttr.name = res.name + '.xml';
            }

            if (res.width !== undefined) resAttr.width = res.width.toString();
            if (res.height !== undefined) resAttr.height = res.height.toString();

            resNode.ele(res.type, resAttr);
        });

        const publish = pkgDesc.ele('publish', { name: packName });
        publish.ele('atlas', { name: 'Default', index: 0 });

        return pkgDesc.end({ pretty: true });
    }
}
