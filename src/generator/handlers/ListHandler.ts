import { UINode } from '../../models/UINode';
import { INodeHandler } from './INodeHandler';

export class ListHandler implements INodeHandler {
    getElementName(_node: UINode): string { return 'list'; }
    populateAttributes(_node: UINode, _attrs: Record<string, string>, _buildId: string): void {}
}
