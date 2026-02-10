import { UINode } from '../../models/UINode';
import { PropertyMapper } from '../../mapper/PropertyMapper';

/**
 * 生成器上下文，在整个 XML 生成过程中共享。
 */
export interface GeneratorContext {
    idCounter: number;
    buildId: string;
}

/**
 * 节点递归生成回调类型。
 * ContainerHandler 用它来递归展平子节点。
 */
export type NodeGeneratorFn = (
    node: UINode,
    parentEle: any,
    buildId: string,
    context: GeneratorContext
) => void;

/**
 * INodeHandler: 每种组件类型的 XML 生成策略接口。
 *
 * 职责划分：
 *  - getElementName:     确定 XML 标签名 (text / image / loader / graph / list / component)
 *  - populateAttributes: 在 PropertyMapper 生成的基础属性上，补充类型特定属性
 *  - writeOverrides:     写入属性覆盖子元素（仅 ComponentRefHandler 使用）
 *  - handleNode:         完全接管节点生成流程（容器展平等特殊场景），返回 true 表示已处理
 */
export interface INodeHandler {
    /**
     * 返回该节点应使用的 XML 元素名称。
     */
    getElementName(node: UINode): string;

    /**
     * 在基础属性（id, name, xy, size, alpha, rotation）之上，
     * 填充该类型节点特有的属性。
     */
    populateAttributes(
        node: UINode,
        attrs: Record<string, string>,
        buildId: string
    ): void;

    /**
     * 写入属性覆盖 (Override) 子元素。
     * 可选，仅 asComponent 引用节点需要实现。
     */
    writeOverrides?(
        node: UINode,
        element: any,
        buildId: string
    ): void;

    /**
     * 完全接管节点的 XML 生成流程。
     * 返回 true 表示已处理完毕（调用方应跳过默认流程）。
     * 返回 false/undefined 表示使用默认流程。
     *
     * 用于 ContainerHandler 的子节点展平和 ComponentRefHandler 的特殊处理。
     */
    handleNode?(
        node: UINode,
        parentEle: any,
        buildId: string,
        context: GeneratorContext,
        mapper: PropertyMapper,
        generateNodeXml: NodeGeneratorFn
    ): boolean;
}
