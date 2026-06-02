import * as path from 'path';
import * as fs from 'fs-extra';

const RULES_DIR = path.resolve(__dirname, '../../rules');

// 缓存已加载的规则文件，避免重复读取
const cache = new Map<string, any>();

export function loadRule<T = any>(filename: string): T {
    if (cache.has(filename)) return cache.get(filename) as T;
    const filePath = path.join(RULES_DIR, filename);
    if (!fs.existsSync(filePath)) {
        throw new Error(`[RuleLoader] 规则文件不存在: ${filePath}`);
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as T;
    cache.set(filename, parsed);
    return parsed;
}

// ─── 类型快捷方法 ────────────────────────────────────────────────────────────

export interface TypeKeywordEntry {
    keywords: string[];
    exclude: string[];
}
export type TypeKeywordsMap = Record<string, TypeKeywordEntry>;

export interface NamingEntry {
    match: string[];
    applyTo: string[];
    nodeTypes: string[];
    convertToLoader?: boolean;
}
export type NamingMap = Record<string, NamingEntry>;

export interface ExcludeRules {
    componentExtraction: { keywords: string[] };
    backgroundDetection: { keywords: string[] };
    coordZeroThreshold: { px: number };
}

export interface ButtonStates {
    pageMap: Record<string, string[]>;
    gearFormat: string;
}

export interface PipelineConfig {
    scale: { value: number };
    imagePipeline: { batchSize: number; concurrency: number; batchDelayMs: number };
    loader: { defaultFillMode: string };
    packageId: { prefix: string; algorithm: string; length: number };
    componentExtraction: { minChildrenToExtract: number };
}

export const Rules = {
    typeKeywords: () => loadRule<TypeKeywordsMap>('type-keywords.json'),
    namingMap:    () => loadRule<NamingMap>('naming-map.json'),
    excludes:     () => loadRule<ExcludeRules>('exclude-names.json'),
    buttonStates: () => loadRule<ButtonStates>('button-states.json'),
    pipeline:     () => loadRule<PipelineConfig>('pipeline-config.json'),
};

/** 根据 type-keywords.json 规则匹配 FGUI ObjectType 名称。未命中返回 null。 */
export function matchObjectType(nodeName: string): string | null {
    const name = nodeName.toLowerCase();
    const map = Rules.typeKeywords();

    for (const [typeName, entry] of Object.entries(map)) {
        if (typeName.startsWith('_')) continue;
        const excluded = entry.exclude.some(ex => name.includes(ex.toLowerCase()));
        if (excluded) continue;
        const matched = entry.keywords.some(kw => name.includes(kw.toLowerCase()));
        if (matched) return typeName;
    }
    return null;
}

/** 根据 naming-map.json 规则，查找子节点的标准 FGUI 角色名称。 */
export function matchStandardName(
    childName: string,
    childType: string,
    parentType: string
): string | null {
    const nm = Rules.namingMap();
    const lname = childName.toLowerCase();

    for (const [stdName, entry] of Object.entries(nm)) {
        if (stdName.startsWith('_')) continue;
        if (!entry.applyTo.includes(parentType)) continue;
        if (!entry.nodeTypes.includes(childType)) continue;
        const matched = entry.match.some(kw => lname.includes(kw.toLowerCase()));
        if (matched) return stdName;
    }
    return null;
}

/** 判断节点名称是否在排除列表中（组件提取阶段）。 */
export function isExcludedFromExtraction(nodeName: string): boolean {
    const { componentExtraction } = Rules.excludes();
    const name = nodeName.toLowerCase();
    return componentExtraction.keywords.some(kw => name.includes(kw.toLowerCase()));
}

/** 判断节点名称是否是背景节点（坐标原点识别）。 */
export function isBackgroundNode(nodeName: string): boolean {
    const { backgroundDetection } = Rules.excludes();
    const name = nodeName.toLowerCase();
    return backgroundDetection.keywords.some(kw => name.includes(kw.toLowerCase()));
}
