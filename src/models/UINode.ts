import { ObjectType } from "./FGUIEnum";

export interface ControllerInfo {
    name: string;
    pages: string;
    selected?: number;
}

export interface GearInfo {
    type: string;
    controller: string;
    pages?: string;
    values?: string;
    default?: string;
}

export interface UINode {
    id: string;
    sourceId?: string;
    name: string;
    type: ObjectType;

    x: number;
    y: number;
    width: number;
    height: number;

    customProps: Record<string, any>;
    styles: Record<string, any>;

    text?: string;
    src?: string;
    fileName?: string;

    children: UINode[];
    parent?: UINode;

    visible?: boolean;
    multiLooks?: Record<number, any>;

    asComponent?: boolean;
    _structuralHash?: string;
    _variantPageId?: number;
    /**
     * 标记此节点应与其父节点一起整体 SSR（不单独拆分子节点）。
     * 用于 Check Button 的 grip：圆形 + 内嵌图标合并为一张图。
     */
    _mergeWithParent?: boolean;
    /**
     * 合并渲染：此节点的 sourceId 应合并到 _mergedInto 主节点一起 SSR。
     * ImagePipeline 扫描时跳过此节点，用主节点的图片 resId 替代。
     */
    _mergedInto?: string;
    _mergedIntoPrimary?: any;
    /**
     * 本地多图合并配置（来自 AI 标注的 merge_layers 字段）。
     * ImageComposer 会下载各图层后用 sharp 合成一张。
     */
    _mergeLayers?: {
        nodes: string[];
        clip?: boolean;
        clip_to?: string;
    };

    overrides?: Record<string, any>;
    rotation?: number;
    extention?: string;
    /**
     * List 组件的 defaultItem 模板名称（AI 标注 list_item_template 字段传入）
     * 对应 FGUI XML: <list defaultItem="ui://{buildId}{itemResId}"/>
     */
    listItemTemplate?: string;
    /** AI 标注的 list item template 名称（用于从子节点中找 template，传给 SubComponentExtractor）*/
    _listItemTemplateName?: string;
    /** AI 标注的 list item template 节点 ID（精确定位，优先于名称查找）*/
    _listItemNodeId?: string;
    /** List 列间距（FlowH 模式，单位像素）*/
    _listColGap?: number;
    /** List 行间距（FlowH 模式，单位像素）*/
    _listRowGap?: number;
    /** List 编辑器预览 item 数量 */
    _listNumItems?: number;
    /**
     * 多变体图层：同一组件有多种视觉变体（如颜色不同），
     * 生成时插入多张 bg 子节点，用 state controller + gearDisplay 控制显隐。
     */
    _variantLayers?: {
        controller: string;
        role: string;
        pages: Array<{ index: number; name: string; node_id: string }>;
    };
    /**
     * Button 模式：Common（普通）| Check（复选/Toggle）| Radio（单选）
     * 对应 FGUI XML: <Button mode="Check"/>
     * 未设置时默认为 Common（普通按钮）
     */
    buttonMode?: string;
    /**
     * Check/Radio Button 的两种状态图片（由 SubComponentExtractor 填写）。
     * 生成的 XML 使用 gearDisplay + button controller 控制显隐：
     *   checkOffSrc → pages="0,2"（up/over 时显示）
     *   checkOnSrc  → pages="1,3"（down/selectedOver 时显示）
     */
    checkOffSrc?: string;
    checkOnSrc?: string;
    value?: number;
    max?: number;
    min?: number;

    controllers?: ControllerInfo[];
    gears?: GearInfo[];

    // AI 语义标注字段（由 AISemanticTagger 写入，优先于关键词匹配）
    semanticType?: string;
    childrenRoles?: Record<string, string>;
    statePages?: Record<number, string>;
    semanticRisks?: string[];
    /** reparent 记录：此节点已被移入的父节点 ID（调试用） */
    _reparentedTo?: string;
}

export interface ResourceInfo {
    id: string;
    name: string;
    type: 'image' | 'component' | 'sound' | 'font' | 'movieclip' | 'misc';
    data?: string;
    isBase64?: boolean;
    width?: number;
    height?: number;
    exported?: boolean;
    /** 对应的 Figma sourceId（用于 ImageComposer 建立映射） */
    _sourceId?: string;
}
