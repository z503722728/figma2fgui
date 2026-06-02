import { UINode } from '../../models/UINode';
import { PropertyMapper } from '../../mapper/PropertyMapper';
import { INodeHandler, GeneratorContext, NodeGeneratorFn } from './INodeHandler';

function hasMultiLooks(node: UINode): boolean {
    return !!(node.multiLooks && Object.keys(node.multiLooks).length > 0);
}

export class ContainerHandler implements INodeHandler {
    getElementName(node: UINode): string {
        if (node.src) return hasMultiLooks(node) ? 'loader' : 'image';
        return 'graph';
    }

    populateAttributes(node: UINode, attrs: Record<string, string>, buildId: string): void {
        if (node.src) {
            if (hasMultiLooks(node)) {
                attrs.url = `ui://${buildId}${node.src}`;
            } else {
                attrs.src = node.src;
                if (node.fileName) attrs.fileName = node.fileName;
            }
            delete attrs.fill; delete attrs.fillColor; delete attrs.lineColor; delete attrs.type;
        }
    }

    handleNode(
        node: UINode, parentEle: any, buildId: string, context: GeneratorContext,
        mapper: PropertyMapper, generateNodeXml: NodeGeneratorFn
    ): boolean {
        if (node.src) return false;

        const testAttr = mapper.mapAttributes(node, 'test');
        const hasVisuals = !!(testAttr.fillColor || (testAttr.lineColor && testAttr.lineSize));
        const hasChildren = !!(node.children && node.children.length > 0);

        if (!hasVisuals && !hasChildren) return true;

        if (hasVisuals) {
            const assignedId = `n${context.idCounter++}`;
            const attributes = mapper.mapAttributes(node, assignedId);
            const graphEle = parentEle.ele('graph', attributes);
            if (node.gears && node.gears.length > 0) {
                node.gears.forEach(g => {
                    const gearEle = graphEle.ele(g.type, { controller: g.controller });
                    if (g.pages) gearEle.att('pages', g.pages);
                });
            }
        }

        if (hasChildren) {
            node.children.forEach(child => {
                const flattenedChild = { ...child };
                flattenedChild.x = node.x + child.x;
                flattenedChild.y = node.y + child.y;
                generateNodeXml(flattenedChild, parentEle, buildId, context);
            });
        }

        return true;
    }
}
