import { ObjectType } from "./FGUIEnum";

export interface ControllerInfo {
    name: string;
    pages: string; // e.g. "0,up,1,down,2,over,3,selectedOver"
    selected?: number;
}

export interface GearInfo {
    type: string; // e.g. "gearDisplay", "gearXY", "gearColor"
    controller: string;
    pages?: string;
    values?: string;
    default?: string;
}

/**
 * Unified UI Node representing a semantic element in the UI tree.
 */
export interface UINode {
    id: string;
    sourceId?: string;
    name: string;
    type: ObjectType;
    
    // Geometry
    x: number;
    y: number;
    width: number;
    height: number;
    
    // Styling & Properties
    customProps: Record<string, any>;
    styles: Record<string, any>; // Changed from Record<string, string> to Record<string, any>
    
    // Content (text or image/svg data)
    text?: string;
    src?: string;
    fileName?: string;
    
    // Hierarchy
    children: UINode[];
    parent?: UINode;
    
    // Visibility
    visible?: boolean;

    // 💡 多状态视觉差异 (Multi-Look Sync)
    // pageId -> modified styles/data
    multiLooks?: Record<number, any>;

    // Component Extraction Flag
    asComponent?: boolean;
    _structuralHash?: string; // 缓存的结构 hash，用于 SubComponentExtractor 跨阶段查找
    _variantPageId?: number;  // 视觉变体检测分配的 pageId，用于 multiLooks 系统
    
    // 💡 属性覆盖数据
    overrides?: Record<string, any>;
    rotation?: number;
    extention?: string;
    value?: number;
    max?: number;
    min?: number;

    // 💡 控制器与控制器关联 (齿轮)
    controllers?: ControllerInfo[];
    gears?: GearInfo[];
}

/**
 * Metadata for package resources.
 */
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
