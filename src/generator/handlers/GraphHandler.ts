import { UINode } from '../../models/UINode';
import { INodeHandler } from './INodeHandler';

export class GraphHandler implements INodeHandler {
    getElementName(_node: UINode): string { return 'graph'; }
    populateAttributes(_node: UINode, _attrs: Record<string, string>, _buildId: string): void {}
}
