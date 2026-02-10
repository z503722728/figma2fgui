import { UINode } from '../../models/UINode';
import { PropertyMapper } from '../../mapper/PropertyMapper';
import { INodeHandler, GeneratorContext, NodeGeneratorFn } from './INodeHandler';

/**
 * ContainerHandler: 处理容器类型节点。
 *
 * 适用于: Component, Group, Button, ProgressBar, Slider, ComboBox, Label
 * （当 asComponent=false 且未被提取为子组件时）
 *
 * 处理流程:
 *  1. 如果管线分配了 SSR 图片 (src)，降级为 image/loader 渲染
 *  2. 检测视觉属性（fillColor, lineColor）
 *  3. 如果有视觉属性，输出一个 graph 元素
 *  4. 如果有子节点，递归展平子节点到父级（FGUI 是扁平列表）
 *  5. 如果既无视觉也无子节点，跳过（剪枝空容器）
 */
export class ContainerHandler implements INodeHandler {

    getElementName(node: UINode): string {
        // 当有 SSR 图片时，降级为 image/loader
        if (node.src) {
            return hasMultiLooks(node) ? 'loader' : 'image';
        }
        // 容器本身作为 graph 输出（仅视觉部分）
        return 'graph';
    }

    populateAttributes(node: UINode, attrs: Record<string, string>, buildId: string): void {
        // SSR 图片模式：填充 src/url 并清理形状属性
        if (node.src) {
            if (hasMultiLooks(node)) {
                attrs.url = `ui://${buildId}${node.src}`;
            } else {
                attrs.src = node.src;
                if (node.fileName) attrs.fileName = node.fileName;
            }
            delete attrs.fill;
            delete attrs.fillColor;
            delete attrs.lineColor;
            delete attrs.type;
        }
    }

    /**
     * 完全接管容器节点的生成流程。
     * 处理 SSR fallback、视觉属性输出、子节点展平。
     */
    handleNode(
        node: UINode,
        parentEle: any,
        buildId: string,
        context: GeneratorContext,
        mapper: PropertyMapper,
        generateNodeXml: NodeGeneratorFn
    ): boolean {
        // 1. SSR 图片模式 —— 不接管，回退到默认流程（由 getElementName + populateAttributes 处理）
        if (node.src) {
            return false;
        }

        // 2. 检测视觉属性和子节点
        const testAttr = mapper.mapAttributes(node, 'test');
        const hasVisuals = !!(testAttr.fillColor || (testAttr.lineColor && testAttr.lineSize));
        const hasChildren = !!(node.children && node.children.length > 0);

        // 3. 空容器剪枝
        if (!hasVisuals && !hasChildren) {
            return true; // 跳过，不输出任何 XML
        }

        // 4. 输出视觉 graph 元素
        if (hasVisuals) {
            const assignedId = `n${context.idCounter++}`;
            const attributes = mapper.mapAttributes(node, assignedId);
            const graphEle = parentEle.ele('graph', attributes);

            // 写入齿轮 (Gears) —— 仅简化版，完整版由 XMLGenerator.writeGears 处理
            if (node.gears && node.gears.length > 0) {
                node.gears.forEach(g => {
                    const gearEle = graphEle.ele(g.type, { controller: g.controller });
                    if (g.pages) gearEle.att('pages', g.pages);
                });
            }
        }

        // 5. 递归展平子节点
        if (hasChildren) {
            // Z-ORDER FIX: 反向迭代
            [...node.children].reverse().forEach(child => {
                const flattenedChild = { ...child };
                flattenedChild.x = node.x + child.x;
                flattenedChild.y = node.y + child.y;
                generateNodeXml(flattenedChild, parentEle, buildId, context);
            });
        }

        return true; // 已完全处理
    }
}

/** 判断节点是否包含 multiLooks 数据 */
function hasMultiLooks(node: UINode): boolean {
    return !!(node.multiLooks && Object.keys(node.multiLooks).length > 0);
}
