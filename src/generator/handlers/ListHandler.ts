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
 *         autoClearItems="true"/>
 *
 * autoClearItems="true"：FGUI 编辑器预览时会清除预置的 item，发布后才正常。
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

        delete attrs.type;
        delete attrs.fillColor;
        // 内联 list 不需要 src/fileName
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
        parentEle.ele(this.getElementName(node), attrs);
        return true;
    }
}
