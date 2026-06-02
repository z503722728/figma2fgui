import { UINode } from '../../models/UINode';
import { INodeHandler } from './INodeHandler';

export class LoaderHandler implements INodeHandler {
    getElementName(_node: UINode): string { return 'loader'; }
    populateAttributes(node: UINode, attrs: Record<string, string>, buildId: string): void {
        if (node.src) {
            attrs.url = `ui://${buildId}${node.src}`;
            delete attrs.fill; delete attrs.fillColor; delete attrs.lineColor; delete attrs.type;
        }
    }
}
