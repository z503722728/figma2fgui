import { UINode } from '../../models/UINode';
import { INodeHandler } from './INodeHandler';

/**
 * ListHandler: 处理 ObjectType.List 节点。
 *
 * - 使用 'list' 标签
 * - 当前无额外类型特定属性需要填充
 */
export class ListHandler implements INodeHandler {

    getElementName(_node: UINode): string {
        return 'list';
    }

    populateAttributes(_node: UINode, _attrs: Record<string, string>, _buildId: string): void {
        // List 的属性由 PropertyMapper 基础映射覆盖
    }
}
