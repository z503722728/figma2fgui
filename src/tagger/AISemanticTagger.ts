import * as path from 'path';
import * as fs from 'fs-extra';
import axios from 'axios';

// ─── 数据结构 ────────────────────────────────────────────────────────────────

/** AI 对单个节点的语义标注结果 */
export interface NodeSemanticTag {
    node_id: string;
    /** FGUI ObjectType 名称：Button / ProgressBar / Slider / Label / List / Component / ... */
    semantic_type: string;
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

interface NodeSummary {
    id: string;
    name: string;
    type: string;        // Figma 原始类型
    width: number;
    height: number;
    children?: NodeSummary[];
}

function summarizeNode(node: any, depth = 0): NodeSummary {
    const summary: NodeSummary = {
        id: node.id ?? node.sourceId ?? '',
        name: node.name ?? '',
        type: node.type ?? '',
        width: Math.round(node.width ?? 0),
        height: Math.round(node.height ?? 0),
    };
    if (node.children?.length && depth < 3) {
        summary.children = node.children.map((c: any) => summarizeNode(c, depth + 1));
    }
    return summary;
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
     * 对一批 UINode 进行 AI 语义标注。
     * 未配置 AI 或标注失败时返回 null，调用方应降级到规则模式。
     */
    async tag(nodes: any[]): Promise<SemanticTagResult | null> {
        if (!this.isAvailable) {
            console.log('⏭️  AI 标注器未配置或已跳过，使用规则模式');
            return null;
        }

        const summaries = nodes.map(n => summarizeNode(n));
        const userPrompt = `请分析以下 Figma 节点树，返回语义标注 JSON：\n\n${JSON.stringify(summaries, null, 2)}`;

        try {
            console.log(`🤖 调用 AI 语义标注 (${this.model})，共 ${nodes.length} 个节点...`);

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
                    timeout: 60000
                }
            );

            const content = resp.data.choices?.[0]?.message?.content ?? '[]';
            let parsed: any;
            try {
                parsed = JSON.parse(content);
            } catch {
                // 有些模型返回的是带代码块的字符串
                const match = content.match(/```json\s*([\s\S]*?)```/);
                parsed = match ? JSON.parse(match[1]) : [];
            }

            // 兼容返回 { tags: [...] } 或直接 [...] 两种格式
            const tags: NodeSemanticTag[] = Array.isArray(parsed)
                ? parsed
                : (parsed.tags ?? parsed.result ?? []);

            const decisions = tags.map(t =>
                `node[${t.node_id}] "${t.semantic_type}"${t.risks?.length ? ` ⚠️ ${t.risks.join('; ')}` : ''}`
            );

            console.log(`✅ AI 标注完成：${tags.length} 个节点`);
            if (tags.some(t => t.risks?.length)) {
                console.warn('⚠️  部分节点存在标注风险，请检查回收 YAML 中的 risks 字段');
            }

            return { tags, decisions };

        } catch (err: any) {
            console.warn(`⚠️  AI 标注失败，降级到规则模式: ${err.message}`);
            return null;
        }
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
            }
            node.children?.forEach(apply);
        };

        nodes.forEach(apply);
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
