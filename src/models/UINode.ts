import { ObjectType } from "./FGUIEnum";

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
    styles: Record<string, string>;
    
    // Content (text or image/svg data)
    text?: string;
    src?: string;
    fileName?: string;
    
    // Hierarchy
    children: UINode[];
    parent?: UINode;
    
    // Component Extraction Flag
    asComponent?: boolean;
    
    // 💡 属性覆盖数据
    overrides?: Record<string, any>;
    rotation?: number;
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
