import { UINode } from '../../models/UINode';
import { PropertyMapper } from '../../mapper/PropertyMapper';

export interface GeneratorContext {
    idCounter: number;
    buildId: string;
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
    handleNode?(
        node: UINode, parentEle: any, buildId: string,
        context: GeneratorContext, mapper: PropertyMapper, generateNodeXml: NodeGeneratorFn
    ): boolean;
}
