import { UINode } from '../../models/UINode';
import { INodeHandler, GeneratorContext, NodeGeneratorFn } from './INodeHandler';
import { PropertyMapper } from '../../mapper/PropertyMapper';

/**
 * ListHandler — 处理 extention="List" 组件的 XML 生成。
 *
 * FGUI List XML 示例：
 *   <list id="n0" name="n0" xy="0,0" size="1760,636"
 *         overflow="scroll" defaultItem="ui://{buildId}{itemResId}"/>
 *
 * defaultItem 的 resId 来自 UINode.listItemTemplate（AI 标注的 list_item_template 字段），
 * 由 SubComponentExtractor 在提取 item template 组件后填入。
 */
export class ListHandler implements INodeHandler {
    getElementName(_node: UINode): string { return 'list'; }

    populateAttributes(node: UINode, attrs: Record<string, string>, buildId: string): void {
        // overflow：默认 scroll（横向可滚动）
        attrs.overflow = 'scroll';

        // layout：横向排列
        attrs.layout = 'FlowH';

        // defaultItem：指向 item template 组件
        if (node.listItemTemplate) {
            attrs.defaultItem = `ui://${buildId}${node.listItemTemplate}`;
        }

        // 清理不需要的属性
        delete attrs.type;
        delete attrs.fillColor;
    }

    handleNode(
        node: UINode, parentEle: any, buildId: string,
        context: GeneratorContext, mapper: PropertyMapper, _generateNodeXml: NodeGeneratorFn
    ): boolean {
        const assignedId = `n${context.idCounter++}`;
        const attrs = mapper.mapAttributes(node, assignedId);
        this.populateAttributes(node, attrs, buildId);
        parentEle.ele(this.getElementName(node), attrs);
        // List 不展开子节点（子节点是 item template，已提取为独立组件）
        return true;
    }
}
