import * as xmlbuilder from 'xmlbuilder';
import { UINode, ResourceInfo, GearInfo } from '../models/UINode';
import { ObjectType } from '../models/FGUIEnum';
import { PropertyMapper } from '../mapper/PropertyMapper';
import { FGUI_SCALE } from '../Common';
import { GeneratorContext } from './handlers/INodeHandler';
import { HandlerRegistry } from './handlers/HandlerRegistry';

/**
 * XMLGenerator: 负责生成有效的 FGUI XML 文件。
 *
 * 通过 HandlerRegistry 将不同组件类型的属性填充逻辑
 * 委托给各自的 Handler，保持主流程精简。
 */
export class XMLGenerator {
    private _mapper = new PropertyMapper();
    private _registry = new HandlerRegistry();

    /**
     * 从 UI 节点列表生成组件 XML。
     * 递归处理树中的子节点。
     */
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

        // 写入控制器 (Controllers)
        if (controllers && controllers.length > 0) {
            controllers.forEach(c => {
                component.ele('controller', { name: c.name, pages: c.pages });
            });
        }

        const displayList = component.ele('displayList');
        const context: GeneratorContext = { idCounter: 0, buildId };

        // 自动背景注入
        // 如果组件根节点有 background-color 或 border，需要一个 graph 来渲染
        if (rootStyles) {
            this.injectBackground(rootStyles, width, height, displayList, context);
        }

        // Z-ORDER FIX: Figma 解析器按绘制顺序（底→顶）输出子节点。
        // FGUI XML 按顺序渲染（画家算法：先=底，后=顶）。
        // 所以正向迭代，不要反转。
        nodes.forEach(node => {
            this.generateNodeXml(node, displayList, buildId, context);
        });

        // Button 扩展组件需要 <Button/> 标签
        if (extention === 'Button') {
            component.ele('Button');
        }

        return component.end({ pretty: true });
    }

    /**
     * 生成单个节点的 XML 并附加到父 XML 元素。
     *
     * 核心编排流程:
     *  1. 可见性检查
     *  2. 查找对应 Handler
     *  3. 如果 Handler 实现了 handleNode，尝试完全接管
     *  4. 否则走默认流程：基础属性映射 → 类型特定属性填充 → 创建元素 → Override → Gear
     */
    private generateNodeXml(node: UINode, parentEle: any, buildId: string, context: GeneratorContext): void {
        if (node.visible === false) return;

        const handler = this._registry.getHandler(node);

        // 尝试由 Handler 完全接管生成流程
        // 用于 ContainerHandler（子节点展平）和 ComponentRefHandler（组件引用）
        if (handler.handleNode) {
            const handled = handler.handleNode(
                node, parentEle, buildId, context,
                this._mapper,
                (n, p, b, c) => this.generateNodeXml(n, p, b, c)
            );
            if (handled) return;
        }

        // 默认流程
        const assignedId = `n${context.idCounter++}`;
        const attrs = this._mapper.mapAttributes(node, assignedId);

        // 让 Handler 填充类型特定属性
        handler.populateAttributes(node, attrs, buildId);

        // 创建 XML 元素
        const eleName = handler.getElementName(node);
        const nodeEle = parentEle.ele(eleName, attrs);

        // 写入 Override（如果有）
        if (handler.writeOverrides) {
            handler.writeOverrides(node, nodeEle, buildId);
        }

        // 统一的 Gear 写入
        this.writeGears(node, nodeEle, buildId);
    }

    /**
     * 统一的齿轮 (Gear) 写入逻辑。
     * 所有节点共用，避免重复代码。
     */
    private writeGears(node: UINode, element: any, buildId: string): void {
        if (!node.gears || node.gears.length === 0) return;

        node.gears.forEach((g: GearInfo) => {
            const gearEle = element.ele(g.type, { controller: g.controller });
            if (g.pages) gearEle.att('pages', g.pages);

            if (g.values) {
                let finalValues = g.values;

                // gearIcon 需要完整的 ui://packageId 前缀才能找到资源
                // FGUI 格式为 ui://packageIdresId (无斜杠分隔)
                if (g.type === 'gearIcon') {
                    const valuesArr = g.values.split('|');
                    finalValues = valuesArr.map(v => {
                        if (v.includes('ui://')) return v;
                        return `ui://${buildId}${v}`;
                    }).join('|');

                    // FGUI 需要 pages 属性才能正确显示 gearIcon
                    const pageIndices = valuesArr.map((_, i) => i).join(',');
                    gearEle.att('pages', pageIndices);
                }
                gearEle.att('values', finalValues);
            }

            if (g.default) gearEle.att('default', g.default);
        });
    }

    /**
     * 注入组件根背景。
     * 如果根节点有 fillColor 或 border，生成一个全尺寸的 graph 元素。
     */
    private injectBackground(
        rootStyles: Record<string, any>,
        width: number,
        height: number,
        displayList: any,
        context: GeneratorContext
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
     * 生成 package.xml 描述。
     */
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

            if (res.type === 'component' && !res.name.endsWith('.xml')) {
                resAttr.name = res.name + '.xml';
            }

            if (res.width !== undefined) resAttr.width = res.width.toString();
            if (res.height !== undefined) resAttr.height = res.height.toString();

            resNode.ele(res.type, resAttr);
        });

        const publish = pkgDesc.ele('publish', { name: packName });
        publish.ele('atlas', { name: 'Default', index: 0 });

        return pkgDesc.end({ pretty: true });
    }
}
