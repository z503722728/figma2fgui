import { UINode } from '../../models/UINode';
import { ObjectType } from '../../models/FGUIEnum';
import { INodeHandler } from './INodeHandler';

export class TextHandler implements INodeHandler {
    getElementName(_node: UINode): string { return 'text'; }
    populateAttributes(node: UINode, attrs: Record<string, string>, _buildId: string): void {
        if (node.type === ObjectType.InputText) attrs.input = 'true';
    }
}
