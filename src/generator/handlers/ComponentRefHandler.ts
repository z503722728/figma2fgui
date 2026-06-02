import { UINode } from '../../models/UINode';
import { ObjectType } from '../../models/FGUIEnum';
import { PropertyMapper } from '../../mapper/PropertyMapper';
import { INodeHandler, GeneratorContext, NodeGeneratorFn } from './INodeHandler';

interface OverrideWriter {
    tagName: string;
    buildAttrs(overrides: Record<string, any>, buildId: string): Record<string, any>;
}

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

export class ComponentRefHandler implements INodeHandler {
    getElementName(_node: UINode): string { return 'component'; }

    populateAttributes(node: UINode, attrs: Record<string, string>, _buildId: string): void {
        if (node.src) attrs.src = node.src;
        if (node.fileName) attrs.fileName = node.fileName;
        delete attrs.type; delete attrs.fillColor;
        if (node.overrides && node.overrides.page !== undefined) {
            attrs.controller = (node.type === ObjectType.Button) ? 'button' : 'state';
            attrs.page = node.overrides.page;
        }
    }

    writeOverrides(node: UINode, element: any, buildId: string): void {
        if (!node.overrides) return;
        const writer = OVERRIDE_WRITERS[node.type];
        if (writer) {
            element.ele(writer.tagName, writer.buildAttrs(node.overrides, buildId));
        } else {
            const customEle = element.ele('Custom');
            for (const [key, value] of Object.entries(node.overrides)) {
                customEle.att(key, value);
            }
        }
    }

    handleNode(
        node: UINode, parentEle: any, buildId: string,
        context: GeneratorContext, mapper: PropertyMapper, _generateNodeXml: NodeGeneratorFn
    ): boolean {
        const assignedId = `n${context.idCounter++}`;
        const attrs = mapper.mapAttributes(node, assignedId);
        this.populateAttributes(node, attrs, buildId);
        const compEle = parentEle.ele(this.getElementName(node), attrs);
        this.writeOverrides(node, compEle, buildId);
        return true;
    }
}
