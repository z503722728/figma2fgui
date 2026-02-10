import { UINode } from '../../models/UINode';
import { INodeHandler } from './INodeHandler';

/**
 * ImageHandler: 处理 ObjectType.Image 节点。
 *
 * - 普通图片使用 'image' 标签
 * - 当存在 multiLooks（多状态切换）时，升级为 'loader' 以支持 gearIcon
 * - 填充 src / url / fileName 属性
 */
export class ImageHandler implements INodeHandler {

    getElementName(node: UINode): string {
        return hasMultiLooks(node) ? 'loader' : 'image';
    }

    populateAttributes(node: UINode, attrs: Record<string, string>, buildId: string): void {
        if (node.src) {
            if (hasMultiLooks(node)) {
                // loader 使用 url 格式: ui://packageIdresId
                attrs.url = `ui://${buildId}${node.src}`;
            } else {
                attrs.src = node.src;
                if (node.fileName) attrs.fileName = node.fileName;
            }
            // 清除不应出现在 image/loader 上的形状属性
            delete attrs.fill;
            delete attrs.fillColor;
            delete attrs.lineColor;
            delete attrs.type;
        }
    }
}

/** 判断节点是否包含 multiLooks 数据 */
function hasMultiLooks(node: UINode): boolean {
    return !!(node.multiLooks && Object.keys(node.multiLooks).length > 0);
}
