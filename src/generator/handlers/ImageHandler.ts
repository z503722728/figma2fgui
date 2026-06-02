import { UINode } from '../../models/UINode';
import { INodeHandler } from './INodeHandler';

function hasMultiLooks(node: UINode): boolean {
    return !!(node.multiLooks && Object.keys(node.multiLooks).length > 0);
}

export class ImageHandler implements INodeHandler {
    getElementName(node: UINode): string { return hasMultiLooks(node) ? 'loader' : 'image'; }
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
}
