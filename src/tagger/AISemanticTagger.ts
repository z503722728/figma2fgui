import * as path from 'path';
import * as fs from 'fs-extra';
import axios from 'axios';

// ─── 数据结构 ────────────────────────────────────────────────────────────────

/** AI 对单个节点的语义标注结果 */
export interface NodeSemanticTag {
    node_id: string;
    /** FGUI ObjectType 名称：Button / ProgressBar / Slider / Label / List / Component / ... */
    semantic_type: string;
    /** AI 推荐的语义化 FGUI 组件名（替换 Frame_24 等机械名称） */
    fgui_name?: string;
    /** 子节点角色映射：node_id → 标准名称（title / icon / bar / grip / ...） */
    children_roles?: Record<string, string>;
    /** 多状态变体页：page_index → 变体描述 */
    state_pages?: Record<number, string>;
    /** 需人工干预的风险说明 */
    risks?: string[];
}

/** AI 标注完整结果（一次请求对应一批节点） */
export interface SemanticTagResult {
    tags: NodeSemanticTag[];
    /** 结构化决策日志，用于回收 YAML */
    decisions: string[];
}

// ─── Figma 节点精简摘要（发给 AI 的轻量表示） ────────────────────────────────
//
// 设计目标：从 3MB 原始 JSON 提炼出 < 8KB 的语义摘要。
//
// 过滤策略：
//   1. 字段白名单：只保留 id/name/type/size/fills_summary/has_text/has_stroke
//      删掉 fillGeometry/strokeGeometry/vectorPaths/relativeTransform 等几何数据
//   2. 深度限制：depth <= MAX_DEPTH（默认 3），超深节点折叠为叶子
//   3. 宽度限制：每层最多 MAX_CHILDREN 个子节点，超出部分记录 "...N more"
//   4. 不可见节点跳过（visible===false）

const MAX_DEPTH    = 5;   // 最多展开 5 层（能看到 Toggle 内部的 Ellipse/Rect）
const MAX_CHILDREN = 12;  // 每层最多 12 个子节点
const MAX_BYTES    = 20 * 1024; // 单次请求摘要上限 20KB（模型支持更大上下文）

interface NodeSummary {
    id: string;
    name: string;
    /** Figma 原始类型（FRAME / INSTANCE / TEXT / VECTOR 等） */
    type: string;
    w: number;
    h: number;
    /** 填充类型摘要：solid/gradient/image/none */
    fill?: string;
    /** 是否有描边 */
    stroke?: true;
    /** 是否含文字（TEXT 直接子节点） */
    hasText?: true;
    /** 子节点被截断时剩余数量 */
    moreSiblings?: number;
    children?: NodeSummary[];
}

function fillSummary(fills: any[]): string | undefined {
    if (!fills?.length) return undefined;
    const visible = fills.filter(f => f.visible !== false);
    if (!visible.length) return undefined;
    const types = new Set(visible.map((f: any) => {
        if (f.type === 'SOLID') return 'solid';
        if (f.type?.includes('GRADIENT')) return 'gradient';
        if (f.type === 'IMAGE') return 'image';
        return 'other';
    }));
    return Array.from(types).join('+');
}

function summarizeNode(node: any, depth = 0): NodeSummary {
    const box = node.absoluteBoundingBox || {};
    const s: NodeSummary = {
        id:   node.id ?? '',
        name: (node.name ?? '').replace(/\s+/g, '_'),
        type: node.type ?? '',
        w:    Math.round(box.width  ?? node.width  ?? 0),
        h:    Math.round(box.height ?? node.height ?? 0),
    };

    const fill = fillSummary(node.fills);
    if (fill) s.fill = fill;
    if (node.strokes?.length) s.stroke = true;

    // 标记是否直接含有文字子节点（帮助 AI 判断是否需要 title 角色）
    if (node.children?.some((c: any) => c.type === 'TEXT')) s.hasText = true;

    if (node.children?.length && depth < MAX_DEPTH) {
        // 过滤不可见节点
        const visible = node.children.filter((c: any) => c.visible !== false);
        const shown = visible.slice(0, MAX_CHILDREN);
        const rest  = visible.length - shown.length;
        s.children = shown.map((c: any) => summarizeNode(c, depth + 1));
        if (rest > 0) s.moreSiblings = rest;
    }

    return s;
}

/**
 * 将节点列表转为精简摘要，并确保总大小不超过 MAX_BYTES。
 * 超出时自动降低 depth 直到满足限制。
 */
function buildSummaries(nodes: any[]): { summaries: NodeSummary[]; depthUsed: number } {
    for (let d = MAX_DEPTH; d >= 1; d--) {
        const summaries = nodes.map(n => summarizeNode(n, MAX_DEPTH - d));
        const json = JSON.stringify(summaries);
        if (json.length <= MAX_BYTES || d === 1) {
            return { summaries, depthUsed: d };
        }
    }
    return { summaries: nodes.map(n => summarizeNode(n, MAX_DEPTH)), depthUsed: MAX_DEPTH };
}

// ─── Skill 文档加载（作为 AI System Prompt 的上下文） ────────────────────────

const SKILL_DIR = path.resolve(__dirname, '../../skill');

function loadSkillModule(filename: string): string {
    const p = path.join(SKILL_DIR, filename);
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf-8');
}

function buildSystemPrompt(): string {
    const g01 = loadSkillModule('G01-global-rules.md');
    const g05 = loadSkillModule('G05-components.md');

    return `你是一个专业的 FairyGUI（FGUI）UI 转换助手。你的任务是分析 Figma 节点树摘要，为每个节点打上语义标注，指导后续的 FGUI XML 生成。

${g01 ? `## 全局规则（G01）\n${g01}` : ''}

${g05 ? `## 组件映射规则（G05）\n${g05}` : ''}

## 你的输出格式

请严格以 JSON 数组格式返回，每个元素对应一个顶层节点：

\`\`\`json
[
  {
    "node_id": "节点ID",
    "semantic_type": "Button | ProgressBar | Slider | Label | List | Component | Text | Image | Group",
    "children_roles": {
      "子节点ID": "title | icon | bar | grip | bg"
    },
    "state_pages": {
      "0": "normal",
      "1": "pressed"
    },
    "risks": ["说明无法自动判断的情况"]
  }
]
\`\`\`

## 判断规则

1. **semantic_type** 优先看节点名称语义，其次看子节点结构
2. **children_roles** 只标注有明确角色的子节点（FGUI 扩展组件必需子节点）
3. **state_pages** 仅对 Button 类节点填写，列出识别出的状态变体
4. **risks** 列出你不确定的映射，方便人工复查
5. 无法判断时，semantic_type 填 "Component"，不要猜测

只返回 JSON，不要有其他解释文字。`;
}

// ─── AI 标注器主体 ────────────────────────────────────────────────────────────

export class AISemanticTagger {
    private apiKey: string;
    private apiBase: string;
    private model: string;
    private systemPrompt: string;

    constructor() {
        this.apiKey  = process.env.AI_API_KEY ?? '';
        this.apiBase = process.env.AI_API_BASE ?? 'https://api.openai.com/v1';
        this.model   = process.env.AI_MODEL ?? 'gpt-4o-mini';
        this.systemPrompt = buildSystemPrompt();
    }

    get isAvailable(): boolean {
        return !!this.apiKey && process.env.SKIP_AI_TAGGER !== 'true';
    }

    /**
     * 对一批原始 Figma 节点进行 AI 语义标注。
     *
     * 流程：
     *  1. buildSummaries() 将原始节点压缩为精简摘要（< 12KB）
     *  2. 如果节点过多，按 AI_BATCH_SIZE 分批，每批独立请求，结果合并
     *  3. 失败时降级到规则模式（返回 null）
     */
    async tag(nodes: any[]): Promise<SemanticTagResult | null> {
        if (!this.isAvailable) {
            console.log('⏭️  AI 标注器未配置或已跳过，使用规则模式');
            return null;
        }

        // 1. 构建精简摘要
        const { summaries, depthUsed } = buildSummaries(nodes);
        const summaryJson = JSON.stringify(summaries);
        console.log(`🤖 AI 标注准备：${nodes.length} 个顶层节点，精简摘要 ${(summaryJson.length / 1024).toFixed(1)} KB（depth=${depthUsed}）`);

        // 2. 按批次大小分批（默认单批，摘要小时不需要分批）
        const AI_BATCH_SIZE = parseInt(process.env.AI_BATCH_SIZE || '20');
        const batches: NodeSummary[][] = [];
        for (let i = 0; i < summaries.length; i += AI_BATCH_SIZE) {
            batches.push(summaries.slice(i, i + AI_BATCH_SIZE));
        }

        console.log(`🤖 调用 AI (${this.model})，共 ${batches.length} 批...`);

        const allTags: NodeSemanticTag[] = [];

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            if (batches.length > 1) console.log(`   批次 ${i + 1}/${batches.length}，${batch.length} 个节点...`);

            const userPrompt = [
                `请分析以下 Figma 节点树摘要（共 ${batch.length} 个顶层节点），返回语义标注 JSON。`,
                `字段说明：id=节点ID, name=名称, type=Figma类型, w/h=尺寸, fill=填充类型, stroke=有描边, hasText=含文字子节点`,
                ``,
                JSON.stringify(batch, null, 2)
            ].join('\n');

            try {
                const tags = await this.callAPI(userPrompt);
                allTags.push(...tags);
            } catch (err: any) {
                console.warn(`⚠️  批次 ${i + 1} 失败，跳过: ${err.message}`);
                // 单批失败不影响其他批次
            }
        }

        if (allTags.length === 0) {
            console.warn('⚠️  所有批次均失败，降级到规则模式');
            return null;
        }

        const decisions = allTags.map(t =>
            `node[${t.node_id}] "${t.semantic_type}"${t.risks?.length ? ` ⚠️ ${t.risks.join('; ')}` : ''}`
        );

        console.log(`✅ AI 标注完成：${allTags.length} 个节点`);
        if (allTags.some(t => t.risks?.length)) {
            console.warn('⚠️  部分节点存在标注风险，请检查 handoff.yaml');
        }

        return { tags: allTags, decisions };
    }

    /**
     * 单次 API 请求，返回标注结果数组。
     */
    private async callAPI(userPrompt: string): Promise<NodeSemanticTag[]> {
        const resp = await axios.post(
            `${this.apiBase}/chat/completions`,
            {
                model: this.model,
                messages: [
                    { role: 'system', content: this.systemPrompt },
                    { role: 'user',   content: userPrompt }
                ],
                temperature: 0.1,
                response_format: { type: 'json_object' }
            },
            {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 90000
            }
        );

        const content = resp.data.choices?.[0]?.message?.content ?? '[]';
        let parsed: any;
        try {
            parsed = JSON.parse(content);
        } catch {
            const match = content.match(/```json\s*([\s\S]*?)```/);
            parsed = match ? JSON.parse(match[1]) : [];
        }

        // 兼容返回 { tags: [...] } 或直接 [...] 两种格式
        return Array.isArray(parsed) ? parsed : (parsed.tags ?? parsed.result ?? []);
    }

    /**
     * 将 AI 标注结果合并回 UINode 树（写入 node.semanticType 和 node.childrenRoles）。
     * 后续 RawFigmaParser / SubComponentExtractor 优先读取这些字段。
     */
    applyTags(nodes: any[], result: SemanticTagResult): void {
        const tagMap = new Map(result.tags.map(t => [t.node_id, t]));

        const apply = (node: any) => {
            const tag = tagMap.get(node.id ?? node.sourceId);
            if (tag) {
                node.semanticType    = tag.semantic_type;
                node.childrenRoles   = tag.children_roles ?? {};
                node.statePages      = tag.state_pages ?? {};
                node.semanticRisks   = tag.risks ?? [];
                // fgui_name：AI 推荐的语义化名称，覆盖 Figma 原始名（如 Frame_24 → col_GoldWide）
                if (tag.fgui_name) {
                    node.name = tag.fgui_name;
                }
            }
            node.children?.forEach(apply);
        };

        nodes.forEach(apply);
    }

    /**
     * Dry-run 模式：生成摘要文件供 IDE AI 分析，不调用 API。
     *
     * 新增：传入 figmaData 可提取 thumbnailUrl，在 prompt 中嵌入界面截图，
     * 让 AI 能同时看「图像」和「节点树」双重信息进行语义划分。
     *
     * 输出文件：
     *   {packagePath}/ai_input_summary.json   → 节点摘要（depth≤5）
     *   {packagePath}/ai_input_prompt.md      → 完整 Prompt（含截图 URL + 节点摘要）
     */
    async dryRun(nodes: any[], packagePath: string, figmaData?: any): Promise<string> {
        const { summaries, depthUsed } = buildSummaries(nodes);
        const summaryJson = JSON.stringify(summaries, null, 2);

        // 写摘要 JSON
        const summaryPath = path.join(packagePath, 'ai_input_summary.json');
        await fs.writeFile(summaryPath, summaryJson, 'utf-8');

        // 提取界面截图 URL（Figma API 返回的 thumbnailUrl）
        const thumbnailUrl: string | undefined = figmaData?.thumbnailUrl;

        // 写 Prompt 说明文件
        const promptPath = path.join(packagePath, 'ai_input_prompt.md');
        const promptContent = [
            '# Figma → FGUI 语义标注任务',
            '',
            '## 操作说明',
            '',
            '1. **先看界面截图**（下方链接），理解整体 UI 布局和组件关系',
            '2. **再看节点摘要**，对照截图理解每个节点对应界面上的哪个部分',
            '3. 按照"输出格式"返回 JSON',
            `4. 将结果保存为 \`${packagePath}/semantic_tags.json\``,
            '5. 再次运行 `bun run convert <figma_url>` 自动读取标注结果',
            '',
            ...(thumbnailUrl ? [
                '## 界面截图',
                '',
                '> 请先查看此截图，理解整体视觉布局，再分析节点摘要：',
                '',
                `![界面截图](${thumbnailUrl})`,
                '',
                `**截图 URL**（若上方图片无法显示，复制到浏览器查看）：`,
                `\`${thumbnailUrl}\``,
                '',
            ] : [
                '> ⚠️ 未获取到界面截图，请通过 Figma 链接手动查看设计稿',
                '',
            ]),
            '## 分析重点',
            '',
            '请特别关注以下情况，需要准确识别：',
            '- **Toggle 开关**（含 Ellipse + Rectangle 的小组件，约 60-80px 高）→ 识别为 `Slider`，并标注 `bar`（轨道）和 `grip`（圆形滑块）子节点',
            '- **重复结构的多状态组件**（相同结构但填充色不同的多个实例）→ 识别为同一组件的变体，用 `state_pages` 标注开/关状态',
            '- **含 Mask 的容器**（如带圆角裁剪的卡片）→ 标注为 `Component`，**不要**标注为 `Image`，让代码决定是否 SSR',
            '- **导航菜单项**（图标 + 文字的重复单元）→ 识别为 `Label`，标注 `icon` 和 `title` 子节点',
            '- **选项卡按钮**（横向排列的多个按钮）→ 识别为 `Button`',
            '',
            '## System Prompt（规则上下文）',
            '',
            this.systemPrompt,
            '',
            '## 节点摘要',
            '',
            `> 摘要大小：${(summaryJson.length / 1024).toFixed(1)} KB，depth≤${depthUsed}，共 ${summaries.length} 个顶层节点`,
            '',
            '```json',
            summaryJson,
            '```',
        ].join('\n');
        await fs.writeFile(promptPath, promptContent, 'utf-8');

        return summaryPath;
    }

    /**
     * 尝试从磁盘读取手动标注结果文件（semantic_tags.json）。
     * 文件由 IDE AI 助手生成后手动放入包目录。
     * 返回 null 表示文件不存在或格式错误。
     */
    async loadManualTags(packagePath: string): Promise<SemanticTagResult | null> {
        const tagsPath = path.join(packagePath, 'semantic_tags.json');
        if (!await fs.pathExists(tagsPath)) return null;

        try {
            const raw = await fs.readFile(tagsPath, 'utf-8');
            const parsed = JSON.parse(raw);
            const tags: NodeSemanticTag[] = Array.isArray(parsed)
                ? parsed
                : (parsed.tags ?? parsed.result ?? []);

            if (tags.length === 0) return null;

            const decisions = tags.map(t =>
                `node[${t.node_id}] "${t.semantic_type}" [手动标注]`
            );
            console.log(`📋 读取手动标注文件: ${tagsPath}（${tags.length} 个节点）`);
            return { tags, decisions };
        } catch (e: any) {
            console.warn(`⚠️  semantic_tags.json 解析失败: ${e.message}`);
            return null;
        }
    }

    /**
     * 生成结构化回收 YAML，供最终验收阶段使用。
     */
    buildHandoffYaml(result: SemanticTagResult): string {
        const lines = [
            `module_id: AI-SemanticTagger`,
            `inputs_used:`,
            `  - skill/G01-global-rules.md`,
            `  - skill/G05-components.md`,
            `  - Figma node summaries`,
            `decisions:`,
            ...result.decisions.map(d => `  - ${d}`),
            `artifacts:`,
            `  - UINode tree with semanticType / childrenRoles annotations`,
            `risks:`,
            ...result.tags.flatMap(t =>
                (t.risks ?? []).map(r => `  - [${t.node_id}] ${r}`)
            ).concat(result.tags.flatMap(t => t.risks ?? []).length === 0 ? ['  - none'] : []),
            `next_module: G06-qc-handoff`
        ];
        return lines.join('\n');
    }
}
