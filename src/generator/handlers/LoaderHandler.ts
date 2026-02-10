import { UINode } from '../../models/UINode';
import { INodeHandler } from './INodeHandler';

/**
 * LoaderHandler: 处理 ObjectType.Loader 节点。
 *
 * - 始终使用 'loader' 标签
 * - 当有 src 时，填充 url 属性（ui://packageIdresId 格式）
 */
export class LoaderHandler implements INodeHandler {

    getElementName(_node: UINode): string {
        return 'loader';
    }

    populateAttributes(node: UINode, attrs: Record<string, string>, buildId: string): void {
        if (node.src) {
            attrs.url = `ui://${buildId}${node.src}`;
            // 清除不应出现在 loader 上的形状属性
            delete attrs.fill;
            delete attrs.fillColor;
            delete attrs.lineColor;
            delete attrs.type;
        }
    }
}
