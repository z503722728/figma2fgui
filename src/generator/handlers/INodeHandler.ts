import { UINode } from '../../models/UINode';
import { PropertyMapper } from '../../mapper/PropertyMapper';

export interface GeneratorContext {
    idCounter: number;
    buildId: string;
    /** 当前组件内已使用的 name 集合（用于去重） */
    usedNames: Set<string>;
    /** 父节点的 children_roles 映射：sourceId → 角色名（由 AI 标注） */
    parentChildrenRoles?: Record<string, string>;
}

export type NodeGeneratorFn = (
    node: UINode,
    parentEle: any,
    buildId: string,
    context: GeneratorContext
) => void;

export interface INodeHandler {
    getElementName(node: UINode): string;
    populateAttributes(node: UINode, attrs: Record<string, string>, buildId: string): void;
    writeOverrides?(node: UINode, element: any, buildId: string): void;
    /** 写出节点的 gear 子元素（可选，未实现时 XMLGenerator 使用默认实现） */
    writeGears?(node: UINode, element: any, buildId: string): void;
    handleNode?(
        node: UINode, parentEle: any, buildId: string,
        context: GeneratorContext, mapper: PropertyMapper, generateNodeXml: NodeGeneratorFn
    ): boolean;
}
