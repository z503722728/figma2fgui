import * as xmlbuilder from 'xmlbuilder';
import { UINode, ResourceInfo, GearInfo } from '../models/UINode';
import { ObjectType } from '../models/FGUIEnum';
import { PropertyMapper } from '../mapper/PropertyMapper';
import { FGUI_SCALE } from '../Common';
import { GeneratorContext } from './handlers/INodeHandler';
import { HandlerRegistry } from './handlers/HandlerRegistry';
import { Rules, isBackgroundNode } from '../rules/RuleLoader';

/**
 * XMLGenerator: 生成有效的 FGUI XML 文件。
 *
 * 改进（design2fgui）：
 * - sortButtonChildren 的背景节点识别从 rules/exclude-names.json 读取。
 */
export class XMLGenerator {
    private _mapper = new PropertyMapper();
    private _registry = new HandlerRegistry();

    public generateComponentXml(
        nodes: UINode[],
        buildId: string,
        width: number = 1440,
        height: number = 1024,
        rootStyles?: Record<string, any>,
        extention?: string,
        controllers?: any[]
    ): string {
        const component = xmlbuilder.create('component').att('size', `${width * FGUI_SCALE},${height * FGUI_SCALE}`);
        if (extention) component.att('extention', extention);

        if (controllers && controllers.length > 0) {
            controllers.forEach(c => component.ele('controller', { name: c.name, pages: c.pages }));
        }

        const displayList = component.ele('displayList');
        const context: GeneratorContext = { idCounter: 0, buildId };

        if (rootStyles) this.injectBackground(rootStyles, width * FGUI_SCALE, height * FGUI_SCALE, displayList, context);

        const sortedNodes = (extention === 'Button') ? this.sortButtonChildren(nodes) : nodes;
        sortedNodes.forEach(node => this.generateNodeXml(node, displayList, buildId, context));

        if (extention === 'Button') component.ele('Button');

        return component.end({ pretty: true });
    }

    private generateNodeXml(node: UINode, parentEle: any, buildId: string, context: GeneratorContext): void {
        if (node.visible === false) return;

        const handler = this._registry.getHandler(node);

        if (handler.handleNode) {
            const handled = handler.handleNode(
                node, parentEle, buildId, context, this._mapper,
                (n, p, b, c) => this.generateNodeXml(n, p, b, c)
            );
            if (handled) return;
        }

        const assignedId = `n${context.idCounter++}`;
        const attrs = this._mapper.mapAttributes(node, assignedId);
        handler.populateAttributes(node, attrs, buildId);
        const eleName = handler.getElementName(node);
        const nodeEle = parentEle.ele(eleName, attrs);

        if (handler.writeOverrides) handler.writeOverrides(node, nodeEle, buildId);
        this.writeGears(node, nodeEle, buildId);
    }

    private writeGears(node: UINode, element: any, buildId: string): void {
        if (!node.gears || node.gears.length === 0) return;
        node.gears.forEach((g: GearInfo) => {
            const gearEle = element.ele(g.type, { controller: g.controller });
            if (g.pages) gearEle.att('pages', g.pages);
            if (g.values) {
                let finalValues = g.values;
                if (g.type === 'gearIcon') {
                    const valuesArr = g.values.split('|');
                    finalValues = valuesArr.map(v => v.includes('ui://') ? v : `ui://${buildId}${v}`).join('|');
                    gearEle.att('pages', valuesArr.map((_, i) => i).join(','));
                }
                gearEle.att('values', finalValues);
            }
            if (g.default) gearEle.att('default', g.default);
        });
    }

    private injectBackground(
        rootStyles: Record<string, any>, width: number, height: number,
        displayList: any, context: GeneratorContext
    ): void {
        const mapper = new PropertyMapper();
        const testNode: any = { styles: rootStyles, type: ObjectType.Graph, width, height, x: 0, y: 0 };
        const testAttrs = mapper.mapAttributes(testNode, 'test');
        if (testAttrs.fillColor || (testAttrs.lineColor && testAttrs.lineSize)) {
            const assignedId = `n${context.idCounter++}`;
            const attrs = mapper.mapAttributes({ ...testNode, id: assignedId, name: assignedId }, assignedId);
            attrs.size = `${width},${height}`;
            attrs.xy = '0,0';
            displayList.ele('graph', attrs);
        }
    }

    /**
     * Button 子节点 Z-order 排序。
     * 背景关键词从 rules/exclude-names.json 读取。
     */
    private sortButtonChildren(nodes: UINode[]): UINode[] {
        return [...nodes].sort((a, b) => {
            const getPriority = (n: UINode): number => {
                if (isBackgroundNode(n.name)) return 0;  // 背景层（规则驱动）
                if (n.src) return 1;                      // 图片层
                return 2;                                 // 文本/内容层
            };
            return getPriority(a) - getPriority(b);
        });
    }

    public generatePackageXml(resources: ResourceInfo[], buildId: string, packName: string): string {
        const pkgDesc = xmlbuilder.create('packageDescription').att('id', buildId);
        const resNode = pkgDesc.ele('resources');

        resources.forEach(res => {
            if (res.type === 'misc') return;
            const resAttr: any = {
                id: res.id,
                name: res.name,
                path: res.type === 'image' ? '/img/' : '/',
                exported: res.exported ? 'true' : 'false'
            };
            if (res.type === 'component' && !res.name.endsWith('.xml')) resAttr.name = res.name + '.xml';
            if (res.width !== undefined) resAttr.width = res.width.toString();
            if (res.height !== undefined) resAttr.height = res.height.toString();
            resNode.ele(res.type, resAttr);
        });

        const publish = pkgDesc.ele('publish', { name: packName });
        publish.ele('atlas', { name: 'Default', index: 0 });
        return pkgDesc.end({ pretty: true });
    }
}
