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

    overrides?: Record<string, any>;
    rotation?: number;
    extention?: string;
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
}
