import { UINode } from '../../models/UINode';
import { ObjectType } from '../../models/FGUIEnum';
import { INodeHandler } from './INodeHandler';

/**
 * TextHandler: 处理 ObjectType.Text 和 ObjectType.InputText 节点。
 *
 * - 元素名称统一为 'text'
 * - InputText 额外添加 input="true" 属性
 */
export class TextHandler implements INodeHandler {

    getElementName(_node: UINode): string {
        return 'text';
    }

    populateAttributes(node: UINode, attrs: Record<string, string>, _buildId: string): void {
        // InputText 需要标记 input 属性
        if (node.type === ObjectType.InputText) {
            attrs.input = 'true';
        }
    }
}
