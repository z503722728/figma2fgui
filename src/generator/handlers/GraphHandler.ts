import { UINode } from '../../models/UINode';
import { INodeHandler } from './INodeHandler';

/**
 * GraphHandler: 处理 ObjectType.Graph 节点。
 *
 * - 使用 'graph' 标签
 * - PropertyMapper 已经处理了 fillColor、lineColor、corner 等视觉属性，
 *   此 handler 无需额外填充属性。
 */
export class GraphHandler implements INodeHandler {

    getElementName(_node: UINode): string {
        return 'graph';
    }

    populateAttributes(_node: UINode, _attrs: Record<string, string>, _buildId: string): void {
        // Graph 的所有属性已由 PropertyMapper.mapGraphProperties 处理
    }
}
