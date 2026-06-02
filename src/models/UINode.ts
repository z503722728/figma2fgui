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
