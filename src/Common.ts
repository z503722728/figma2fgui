export interface ExportConfig {
    reactFile: string;
    outPath: string;
    packName: string;
    subCom: string;
}

export enum ItemType {
    IMAGE = 'image',
    COMPONENT = 'component',
    TEXT = 'text'
}
