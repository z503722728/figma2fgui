import { UINode, GearInfo } from '../../models/UINode';
import { PropertyMapper } from '../../mapper/PropertyMapper';
import { FGUI_SCALE } from '../../Common';
import { isBackgroundNode } from '../../rules/RuleLoader';
import { INodeHandler, GeneratorContext, NodeGeneratorFn } from './INodeHandler';

/**
 * ButtonHandler — 处理 extention="Button" 组件的完整 XML 生成。
 *
 * 承担原本分散在 XMLGenerator / SubComponentExtractor 里的逻辑：
 *  - 输出 <Button mode="Check|Radio"/> 标签（位于 displayList 之前）
 *  - 对 Check/Radio Button 自动补充 button controller 声明
 *  - 子节点 Z-order 排序（背景→图片→文字）
 *  - 统一 gear 输出：gearIcon / gearDisplay / gearXY（含 tween）
 *
 * 决策规则（来自 analyzeMultiLooks 阶段已标记的子节点数据）：
 *  - 子节点有 multiLooks → ImagePipeline 已生成 off/on 图 → gearIcon 换图
 *  - 子节点有 gearDisplay gear → 显隐切换
 *  - 子节点有 gearXY gear → 位置补间（保留兼容，主流路径已改用 gearDisplay）
 */
export class ButtonHandler implements INodeHandler {

    // ─── INodeHandler 接口 ──────────────────────────────────────────────────────

    getElementName(_node: UINode): string { return 'component'; }

    populateAttributes(_node: UINode, attrs: Record<string, string>, _buildId: string): void {
        // component 元素的属性由 XMLGenerator.generateComponentXml 写，这里不重复
        delete attrs.type; delete attrs.fillColor;
    }

    /**
     * handleNode 完整接管 Button 组件的生成：
     * 在 generateComponentXml 阶段调用（extention=Button 时通过 registry 路由到此）。
     *
     * 注意：这里处理的是「Button 组件内部子节点」的渲染，
     * 而非 Button 组件本身的 component 标签（那由 generateComponentXml 写）。
     * 所以这个 handler 直接写子节点到 parentEle（displayList）。
     */
    handleNode(
        node: UINode, parentEle: any, buildId: string,
        context: GeneratorContext, mapper: PropertyMapper, generateNodeXml: NodeGeneratorFn
    ): boolean {
        // 只处理有 extention=Button 的组件节点（通过 generateComponentXml 路径调用）
        // 普通 Button 引用节点交给 ComponentRefHandler
        if (node.asComponent && node.src) return false;

        // 子节点按 Z-order 排序后逐个生成
        const sortedChildren = this.sortChildren(node.children || []);
        sortedChildren.forEach(child => generateNodeXml(child, parentEle, buildId, context));
        return true;
    }

    // ─── 辅助方法（由 XMLGenerator 或 generateComponentXml 专用路径调用） ───────

    /**
     * 生成 Button 组件的前置声明部分（Button 标签 + controller）。
     * 在 displayList 之前插入到 component 元素。
     */
    writeButtonPreamble(componentEle: any, buttonMode: string | undefined): void {
        // <Button mode="Check"/> 或 <Button/>
        const btnAttrs: Record<string, string> = {};
        if (buttonMode && buttonMode !== 'Common') {
            btnAttrs.mode = buttonMode;
        }
        componentEle.ele('Button', Object.keys(btnAttrs).length ? btnAttrs : undefined);

        // Check/Radio Button：显式声明 button controller
        // FairyGUI 编辑器格式：0=up, 1=down, 2=over, 3=selectedOver
        const isCheckOrRadio = buttonMode === 'Check' || buttonMode === 'Radio';
        if (isCheckOrRadio) {
            componentEle.ele('controller', {
                name: 'button',
                pages: '0,up,1,down,2,over,3,selectedOver'
            });
        }
    }

    /**
     * 为节点写出所有 gear 子元素。
     * 支持：gearIcon（换图）/ gearDisplay（显隐）/ gearXY（位置补间）/ 其他
     */
    writeGears(node: UINode, element: any, buildId: string): void {
        if (!node.gears?.length) return;

        node.gears.forEach((g: GearInfo) => {
            if (g.type === 'gearXY') {
                // <gearXY controller="button" pages="1,3" values="x0,y0,x1,y1" default="x,y" tween="true"/>
                const attrs: Record<string, string> = { controller: g.controller };
                if (g.pages)   attrs.pages   = g.pages;
                if (g.values)  attrs.values  = g.values;
                if (g.default) attrs.default = g.default;
                attrs.tween = 'true';
                element.ele(g.type, attrs);
                return;
            }

            if (g.type === 'gearDisplay') {
                // <gearDisplay controller="button" pages="0,2"/>
                const attrs: Record<string, string> = { controller: g.controller };
                if (g.pages) attrs.pages = g.pages;
                element.ele(g.type, attrs);
                return;
            }

            if (g.type === 'gearIcon') {
                // <gearIcon controller="button" pages="0,1,2,3" values="ui://...off|ui://...on|..."/>
                const gearEle = element.ele(g.type, { controller: g.controller });
                if (g.values) {
                    const valuesArr = g.values.split('|');
                    const finalValues = valuesArr.map(v =>
                        v.includes('ui://') ? v : `ui://${buildId}${v}`
                    ).join('|');
                    gearEle.att('pages', valuesArr.map((_, i) => i).join(','));
                    gearEle.att('values', finalValues);
                } else if (g.pages) {
                    gearEle.att('pages', g.pages);
                }
                if (g.default) gearEle.att('default', g.default);
                return;
            }

            // 其他 gear 类型（gearColor、gearSize 等）
            const gearEle = element.ele(g.type, { controller: g.controller });
            if (g.pages)   gearEle.att('pages', g.pages);
            if (g.values)  gearEle.att('values', g.values);
            if (g.default) gearEle.att('default', g.default);
        });
    }

    // ─── 私有工具 ────────────────────────────────────────────────────────────────

    /** Button 子节点 Z-order 排序：背景 → 图片 → 文字/图标 */
    private sortChildren(nodes: UINode[]): UINode[] {
        return [...nodes].sort((a, b) => {
            const priority = (n: UINode): number => {
                if (isBackgroundNode(n.name)) return 0;
                if (n.src) return 1;
                return 2;
            };
            return priority(a) - priority(b);
        });
    }
}
