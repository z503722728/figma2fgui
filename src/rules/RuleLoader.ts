import * as path from 'path';
import * as fs from 'fs-extra';

const RULES_DIR = path.resolve(__dirname, '../../rules');

// 缓存已加载的规则文件，避免重复读取
const cache = new Map<string, any>();

// 当前项目的动态规则（由 AI 生成，优先级高于静态规则）
let _projectRules: ProjectRules | null = null;
let _projectRulesPath = '';

// ─── 动态规则结构（由 AI 生成的 project-rules.json）────────────────────────

export interface ProjectRules {
    _generated_by?: string;
    _figma_url?: string;
    _note?: string;

    /** 覆盖 type-keywords.json：节点名关键词 → FGUI 组件类型 */
    typeKeywords?: Record<string, string[]>;

    /** 覆盖 exclude-names.json：被识别为背景原点的节点名 */
    backgroundNodeNames?: string[];

    /** 覆盖 exclude-names.json：不提取为子组件的节点名 */
    excludeFromExtraction?: string[];

    /** 描述重复结构的组件组（用于多状态合并） */
    componentGroups?: ComponentGroupRule[];

    /** 覆盖 pipeline-config.json：坐标归零阈值 */
    coordZeroThreshold?: number;

    /** 覆盖 pipeline-config.json：全局缩放 */
    scale?: number;
}

export interface ComponentGroupRule {
    _note?: string;
    namePattern: string;
    semanticType: string;
    stateIndicator?: string;
    states?: Record<string, any>;
}

/**
 * 加载项目动态规则文件。
 * 由 ConvertAgent 在启动时调用，传入包目录路径。
 */
export function loadProjectRules(packagePath: string): void {
    const rulesPath = path.join(packagePath, 'project-rules.json');
    _projectRulesPath = rulesPath;
    if (!fs.existsSync(rulesPath)) {
        _projectRules = null;
        return;
    }
    try {
        _projectRules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8')) as ProjectRules;
        console.log(`📐 已加载动态规则: ${rulesPath}`);
        if (_projectRules.typeKeywords) {
            const types = Object.keys(_projectRules.typeKeywords).join(', ');
            console.log(`   类型关键词覆盖: ${types}`);
        }
        if (_projectRules.backgroundNodeNames?.length) {
            console.log(`   背景节点名: ${_projectRules.backgroundNodeNames.join(', ')}`);
        }
    } catch (e: any) {
        console.warn(`⚠️  project-rules.json 解析失败，使用静态规则: ${e.message}`);
        _projectRules = null;
    }
    // 动态规则加载后清空缓存，确保静态规则也重新读取（用于合并）
    cache.clear();
}

export function getProjectRules(): ProjectRules | null {
    return _projectRules;
}

// ─── 静态规则加载（rules/ 目录）─────────────────────────────────────────────

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

// ─── 类型定义 ────────────────────────────────────────────────────────────────

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

// ─── 动态规则优先的查询函数 ──────────────────────────────────────────────────

/**
 * 匹配节点名 → FGUI ObjectType。
 * 优先级：project-rules.typeKeywords > rules/type-keywords.json
 *
 * 匹配前统一把空格转为下划线，使 "Group 4613" 和 "Group_4613" 等价。
 */
export function matchObjectType(nodeName: string): string | null {
    // 空格/下划线等价：匹配时统一转小写+下划线
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '_');
    const name = normalize(nodeName);

    // 1. 动态规则优先
    if (_projectRules?.typeKeywords) {
        for (const [typeName, keywords] of Object.entries(_projectRules.typeKeywords)) {
            if (typeName.startsWith('_')) continue;
            if (keywords.some(kw => name.includes(normalize(kw)))) {
                return typeName;
            }
        }
    }

    // 2. 静态规则兜底
    const map = Rules.typeKeywords();
    for (const [typeName, entry] of Object.entries(map)) {
        if (typeName.startsWith('_')) continue;
        const excluded = entry.exclude.some(ex => name.includes(normalize(ex)));
        if (excluded) continue;
        const matched = entry.keywords.some(kw => name.includes(normalize(kw)));
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

/**
 * 判断节点名是否应该排除出组件提取。
 * 优先级：project-rules.excludeFromExtraction > rules/exclude-names.json
 * 匹配时空格/下划线等价。
 */
export function isExcludedFromExtraction(nodeName: string): boolean {
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '_');
    const name = normalize(nodeName);

    if (_projectRules?.excludeFromExtraction?.length) {
        if (_projectRules.excludeFromExtraction.some(kw => name.includes(normalize(kw)))) return true;
    }
    const { componentExtraction } = Rules.excludes();
    return componentExtraction.keywords.some(kw => name.includes(normalize(kw)));
}

/**
 * 判断节点名是否是背景节点。
 * 优先级：project-rules.backgroundNodeNames > rules/exclude-names.json
 * project-rules 使用精确匹配（等价空格/下划线），静态规则使用包含匹配。
 */
export function isBackgroundNode(nodeName: string): boolean {
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '_');
    const name = normalize(nodeName);

    if (_projectRules?.backgroundNodeNames?.length) {
        if (_projectRules.backgroundNodeNames.some(n => name === normalize(n))) return true;
    }
    const { backgroundDetection } = Rules.excludes();
    return backgroundDetection.keywords.some(kw => name.includes(normalize(kw)));
}

/**
 * 获取坐标归零阈值。
 * 优先级：project-rules.coordZeroThreshold > rules/pipeline-config.json
 */
export function getCoordZeroThreshold(): number {
    if (_projectRules?.coordZeroThreshold !== undefined) {
        return _projectRules.coordZeroThreshold;
    }
    try {
        return Rules.excludes().coordZeroThreshold.px;
    } catch {
        return 3.5;
    }
}

/**
 * 获取全局缩放倍率。
 * 优先级：project-rules.scale > rules/pipeline-config.json
 */
export function getScale(): number {
    if (_projectRules?.scale !== undefined) {
        return _projectRules.scale;
    }
    try {
        return Rules.pipeline().scale.value;
    } catch {
        return 2;
    }
}
