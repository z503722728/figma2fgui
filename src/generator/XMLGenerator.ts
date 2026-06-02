import * as xmlbuilder from 'xmlbuilder';
import { UINode, ResourceInfo, GearInfo } from '../models/UINode';
import { ObjectType } from '../models/FGUIEnum';
import { PropertyMapper } from '../mapper/PropertyMapper';
import { FGUI_SCALE } from '../Common';
import { GeneratorContext } from './handlers/INodeHandler';
import { HandlerRegistry } from './handlers/HandlerRegistry';

/**
 * XMLGenerator: 生成有效的 FGUI XML 文件。
 *
 * Button 组件的特殊逻辑（controller 声明、gears 输出）已下沉到 ButtonHandler。
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
        controllers?: any[],
        buttonMode?: string
    ): string {
        const component = xmlbuilder.create('component').att('size', `${width * FGUI_SCALE},${height * FGUI_SCALE}`);
        if (extention) component.att('extention', extention);

        if (extention === 'Button') {
            // Button 前置声明（Button标签 + controller）由 ButtonHandler 统一处理
            this._registry.getButtonHandler().writeButtonPreamble(component, buttonMode);
        } else if (controllers && controllers.length > 0) {
            controllers.forEach(c => component.ele('controller', { name: c.name, pages: c.pages }));
        }

        const displayList = component.ele('displayList');
        const context: GeneratorContext = { idCounter: 0, buildId };

        if (rootStyles) this.injectBackground(rootStyles, width * FGUI_SCALE, height * FGUI_SCALE, displayList, context);

        nodes.forEach(node => this.generateNodeXml(node, displayList, buildId, context));

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

        // gear 输出：handler 自定义 > ButtonHandler（当节点有 button gear 类型时）> 默认
        if (handler.writeGears) {
            handler.writeGears(node, nodeEle, buildId);
        } else if (node.gears?.some(g => ['gearDisplay', 'gearXY'].includes(g.type))) {
            // 子节点含 button controller 专用 gear → 用 ButtonHandler 输出
            this._registry.getButtonHandler().writeGears(node, nodeEle, buildId);
        } else {
            this.writeGearsDefault(node, nodeEle, buildId);
        }
    }

    /** 默认 gear 输出（非 Button 节点使用） */
    private writeGearsDefault(node: UINode, element: any, buildId: string): void {
        if (!node.gears?.length) return;
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
