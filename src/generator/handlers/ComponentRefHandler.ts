import { UINode } from '../../models/UINode';
import { ObjectType } from '../../models/FGUIEnum';
import { PropertyMapper } from '../../mapper/PropertyMapper';
import { INodeHandler, GeneratorContext, NodeGeneratorFn } from './INodeHandler';

/**
 * Override 写入策略接口。
 * 每种扩展组件类型实现自己的 Override 写入逻辑。
 */
interface OverrideWriter {
    tagName: string;
    buildAttrs(overrides: Record<string, any>, buildId: string): Record<string, any>;
}

/**
 * 各扩展组件类型的 Override 写入策略注册表。
 */
const OVERRIDE_WRITERS: Partial<Record<ObjectType, OverrideWriter>> = {
    [ObjectType.Button]: {
        tagName: 'Button',
        buildAttrs(overrides, buildId) {
            const attr: Record<string, any> = {};
            if (overrides.title) attr.title = overrides.title;
            if (overrides.icon) attr.icon = `ui://${buildId}${overrides.icon}`;
            return attr;
        }
    },
    [ObjectType.ProgressBar]: {
        tagName: 'ProgressBar',
        buildAttrs(overrides, _buildId) {
            const attr: Record<string, any> = {};
            if (overrides.value !== undefined) attr.value = overrides.value;
            if (overrides.max !== undefined) attr.max = overrides.max;
            return attr;
        }
    },
    [ObjectType.Slider]: {
        tagName: 'Slider',
        buildAttrs(overrides, _buildId) {
            const attr: Record<string, any> = {};
            if (overrides.value !== undefined) attr.value = overrides.value;
            if (overrides.max !== undefined) attr.max = overrides.max;
            return attr;
        }
    },
    [ObjectType.ComboBox]: {
        tagName: 'ComboBox',
        buildAttrs(overrides, _buildId) {
            const attr: Record<string, any> = {};
            if (overrides.title) attr.title = overrides.title;
            return attr;
        }
    }
};

/**
 * ComponentRefHandler: 处理 asComponent=true 的引用节点。
 *
 * 这些节点是已提取为独立子组件的占位符，在父组件中以 <component> 标签引用。
 *
 * 处理流程:
 *  1. 使用 'component' 标签
 *  2. 填充 src、fileName
 *  3. 写入 controller & page 状态
 *  4. 根据组件类型分发 Override 写入
 */
export class ComponentRefHandler implements INodeHandler {

    getElementName(_node: UINode): string {
        return 'component';
    }

    populateAttributes(node: UINode, attrs: Record<string, string>, _buildId: string): void {
        // 设置组件引用
        if (node.src) attrs.src = node.src;
        if (node.fileName) attrs.fileName = node.fileName;

        // 清除不相关的属性
        delete attrs.type;
        delete attrs.fillColor;

        // 写入实例状态 (Controller & Page)
        if (node.overrides && node.overrides.page !== undefined) {
            attrs.controller = (node.type === ObjectType.Button) ? 'button' : 'state';
            attrs.page = node.overrides.page;
        }
    }

    /**
     * 写入属性覆盖 (Override) 子元素。
     * 根据组件类型使用对应的 OverrideWriter 策略。
     */
    writeOverrides(node: UINode, element: any, buildId: string): void {
        if (!node.overrides) return;

        const writer = OVERRIDE_WRITERS[node.type];
        if (writer) {
            // 使用注册的策略写入
            const overrideAttrs = writer.buildAttrs(node.overrides, buildId);
            element.ele(writer.tagName, overrideAttrs);
        } else {
            // 通用自定义属性覆盖
            const customEle = element.ele('Custom');
            for (const [key, value] of Object.entries(node.overrides)) {
                customEle.att(key, value);
            }
        }
    }

    /**
     * 完全接管组件引用节点的生成流程。
     */
    handleNode(
        node: UINode,
        parentEle: any,
        buildId: string,
        context: GeneratorContext,
        mapper: PropertyMapper,
        _generateNodeXml: NodeGeneratorFn
    ): boolean {
        const assignedId = `n${context.idCounter++}`;
        const attrs = mapper.mapAttributes(node, assignedId);

        this.populateAttributes(node, attrs, buildId);

        const compEle = parentEle.ele(this.getElementName(node), attrs);

        this.writeOverrides(node, compEle, buildId);

        return true; // 完全处理，不走默认流程
    }
}
