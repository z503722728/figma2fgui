import { UINode } from '../../models/UINode';
import { INodeHandler, GeneratorContext, NodeGeneratorFn } from './INodeHandler';
import { PropertyMapper } from '../../mapper/PropertyMapper';

function deduplicateName(name: string, usedNames: Set<string>): string {
    if (!usedNames.has(name)) { usedNames.add(name); return name; }
    let i = 2;
    while (usedNames.has(`${name}_${i}`)) i++;
    const u = `${name}_${i}`; usedNames.add(u); return u;
}

/**
 * ListHandler — 将 List 节点直接内联为 <list> 标签输出。
 *
 * 不再通过 list_xxx.xml 中间文件引用，而是在父组件的 displayList 里直接生成：
 *   <list id="n0" name="list_Items" xy="..." size="..."
 *         layout="FlowH" overflow="scroll"
 *         defaultItem="ui://{buildId}{itemResId}"
 *         autoClearItems="true">
 *     <item/>  ← numItems 个，供编辑器预览；发布时 autoClearItems 自动清空
 *   </list>
 */
export class ListHandler implements INodeHandler {
    getElementName(_node: UINode): string { return 'list'; }

    populateAttributes(node: UINode, attrs: Record<string, string>, buildId: string): void {
        attrs.overflow = 'scroll';
        attrs.layout   = 'FlowH';
        attrs.autoClearItems = 'true';

        if (node.listItemTemplate) {
            attrs.defaultItem = `ui://${buildId}${node.listItemTemplate}`;
        }

        if (node._listColGap   !== undefined) attrs.colGap   = String(node._listColGap);
        if (node._listRowGap   !== undefined) attrs.lineGap  = String(node._listRowGap);  // FGUI 行间距属性名是 lineGap
        if (node._listNumItems !== undefined) attrs.numItems = String(node._listNumItems);

        delete attrs.type;
        delete attrs.fillColor;
        delete attrs.src;
        delete attrs.fileName;
    }

    handleNode(
        node: UINode, parentEle: any, buildId: string,
        context: GeneratorContext, mapper: PropertyMapper, _generateNodeXml: NodeGeneratorFn
    ): boolean {
        const assignedId = `n${context.idCounter++}`;
        const roleName = context.parentChildrenRoles?.[node.sourceId ?? ''];
        const semanticName = roleName
            ? deduplicateName(roleName, context.usedNames)
            : assignedId;
        const attrs = mapper.mapAttributes(node, assignedId, semanticName);
        this.populateAttributes(node, attrs, buildId);

        const listEle = parentEle.ele(this.getElementName(node), attrs);

        // 生成预览用的 <item/>，发布时 autoClearItems 自动清空
        const numItems = node._listNumItems ?? 0;
        for (let i = 0; i < numItems; i++) {
            listEle.ele('item');
        }

        return true;
    }
}
