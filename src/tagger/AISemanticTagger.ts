import * as path from 'path';
import * as fs from 'fs-extra';
import axios from 'axios';

// ─── 数据结构 ────────────────────────────────────────────────────────────────

/** AI 对单个节点的语义标注结果 */
export interface NodeSemanticTag {
    node_id: string;
    /** FGUI ObjectType 名称：Button / ProgressBar / Slider / Label / List / Component / ... */
    semantic_type: string;
    /**
     * Button 工作模式（仅 semantic_type=Button 时有效）：
     *   Common  = 普通按钮（默认，不需要填写）
     *   Check   = 复选/Toggle 开关（可 selected/unselected 切换）
     *   Radio   = 单选按钮（同组互斥）
     */
    button_mode?: 'Common' | 'Check' | 'Radio';
    /** AI 推荐的语义化 FGUI 组件名（替换 Frame_24 等机械名称） */
    fgui_name?: string;
    /**
     * 本地多图合并（取代 Figma 多次 SSR）：
     *   nodes   = 要合并的 sourceId 列表（按顺序叠加，从下到上）
     *   clip    = 是否裁剪到 clip_to 节点的尺寸（纹理超出边界时需要）
     *   clip_to = 裁剪基准节点 sourceId（默认用 nodes[0]）
     */
    merge_layers?: {
        nodes: string[];
        clip?: boolean;
        clip_to?: string;
    };
    /** 标记此节点已被合并到父节点，不单独生成图片（在 _merged_into_parent 指向的节点输出） */
    _merged_into_parent?: string;
    /** 子节点角色映射：node_id → 标准名称（title / icon / bar / grip / ...） */
    children_roles?: Record<string, string>;
    /** 多状态变体页：page_index → 变体描述 */
    state_pages?: Record<number, string>;
    /**
     * List 组件的 item template 名称。
     * AI 在分析时填写，代码会把该名称对应的第一个子节点提取为 defaultItem 组件。
     */
    list_item_template?: string;
    /**
     * List 组件的 item template 节点 ID（精确指定，优先于 list_item_template 名称查找）。
     * 当 item template 节点不是 list 的直接子节点时，用此字段精确定位。
     */
    list_item_node_id?: string;
    /**
     * List 布局参数（layout=FlowH 时有效）：
     *   col_gap      = 列间距（像素）
     *   row_gap      = 行间距（像素）
     *   num_items    = 编辑器预览时展示的 item 数量（numItems）
     */
    list_col_gap?: number;
    list_row_gap?: number;
    list_num_items?: number;
    /**
     * List item 变体图层：同一个组件有多种视觉变体（如不同颜色），
     * 用 state controller + gearDisplay 控制哪一张 bg 显示。
     *
     *   controller = FGUI controller 名称（通常是 "state"）
     *   role       = 变体图层在组件内的角色名（如 "bg"）
     *   pages      = 各变体：index（页码）、name（页名）、node_id（Figma 节点 ID）
     */
    variant_layers?: {
        controller: string;
        role: string;
        pages: Array<{ index: number; name: string; node_id: string }>;
    };
    /**
     * 节点重新挂载（层级调整）：
     *   new_parent = 目标父节点 ID（此节点将从当前位置移入该父节点）
     *   role       = 在新父节点中的角色名（写入新父节点的 children_roles）
     *
     * 使用场景：
     *   - Figma 中平级的两个 Frame，设计上应属于父子关系
     *   - 弹窗底部按钮栏被单独放在页面顶层，实际应归入弹窗组件
     *   - 节点坐标会自动转换为相对新父节点的坐标（基于 absoluteBoundingBox）
     */
    reparent?: {
        new_parent: string;
        role?: string;
    };
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

    return `你是一个专业的 FairyGUI（FGUI）UI 转换助手。你的任务是分析 Figma 节点树摘要，为每个节点打上语义标注，同时可以调整节点层级关系，指导后续的 FGUI XML 生成。

${g01 ? `## 全局规则（G01）\n${g01}` : ''}

${g05 ? `## 组件映射规则（G05）\n${g05}` : ''}

## 你的输出格式

请严格以 JSON 数组格式返回，每个元素对应一个节点：

\`\`\`json
[
  {
    "node_id": "节点ID",
    "semantic_type": "Button | ProgressBar | Slider | Label | List | Component | Text | Image | Group",
    "fgui_name": "语义化组件名（可选，替换 Frame_24 等机械名）",
    "children_roles": {
      "子节点ID": "title | icon | bar | grip | bg"
    },
    "reparent": {
      "new_parent": "目标父节点ID",
      "role": "在新父节点中的角色名（可选）"
    },
    "merge_layers": {
      "nodes": ["节点ID1", "节点ID2"],
      "clip": true,
      "clip_to": "裁剪基准节点ID"
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

## reparent（层级调整）使用规则

当以下情况出现时，输出 reparent 字段将节点移入正确的父节点：

- **弹窗按钮栏**：底部的"确定/取消"按钮栏在 Figma 中与弹窗同级，但设计上属于弹窗的一部分
  → 将按钮栏 reparent 到弹窗节点
- **头部/尾部装饰条**：与主体容器同级的顶部/底部装饰，实际应在容器内
  → reparent 到主体容器
- **浮层与主面板同级**：某个小组件（角标、提示气泡）位置上完全在某个大容器内，但 Figma 层级是平级
  → reparent 到包含它的大容器
- **判断标准**：节点的 absoluteBoundingBox 完全在目标父节点的 boundingBox 范围内，且名称/语义上归属明确

注意：
- 只在确定归属时才输出 reparent，不确定则保持原始层级
- reparent 的目标必须是同一批节点中存在的 node_id
- 坐标会自动转换，无需手动计算

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
     *
     * 步骤：
     *  1. reparentNodes()：按 reparent 指令调整节点层级（坐标自动转换）
     *  2. 第二遍：写入 semanticType / childrenRoles 等字段
     */
    applyTags(nodes: any[], result: SemanticTagResult): void {
        const tagMap = new Map(result.tags.map(t => [t.node_id, t]));

        // ── 步骤 1：执行 reparent（层级调整） ──────────────────────────────────
        this.reparentNodes(nodes, tagMap);

        // ── 步骤 2：写语义字段 ─────────────────────────────────────────────────
        const apply = (node: any) => {
            const tag = tagMap.get(node.id ?? node.sourceId);
            if (tag) {
                node.semanticType    = tag.semantic_type;
                node.childrenRoles   = tag.children_roles ?? {};
                node.statePages      = tag.state_pages ?? {};
                node.semanticRisks   = tag.risks ?? [];
                // button_mode：Check=Toggle/复选，Radio=单选
                if (tag.button_mode && tag.button_mode !== 'Common') {
                    node.buttonMode = tag.button_mode;
                }
                // fgui_name：AI 推荐的语义化名称
                if (tag.fgui_name) {
                    node.name = tag.fgui_name;
                }
                // merge_layers：本地合并多图
                if (tag.merge_layers) {
                    node._mergeLayers = tag.merge_layers;
                    node._mergedNodes = tag.merge_layers.nodes;
                }
                // _merged_into_parent：此节点已被合并，不单独输出
                if (tag._merged_into_parent) {
                    node._mergedInto = tag._merged_into_parent;
                }
                // list_item_template：List 组件的 item template 名称
                if (tag.list_item_template) {
                    node._listItemTemplateName = tag.list_item_template;
                }
                // list_item_node_id：精确指定 template 节点 ID
                if (tag.list_item_node_id) {
                    node._listItemNodeId = tag.list_item_node_id;
                }
                // list 布局参数
                if (tag.list_col_gap !== undefined) node._listColGap = tag.list_col_gap;
                if (tag.list_row_gap !== undefined) node._listRowGap = tag.list_row_gap;
                if (tag.list_num_items !== undefined) node._listNumItems = tag.list_num_items;
                // variant_layers：多变体图层（state controller + gearDisplay）
                if (tag.variant_layers) {
                    node._variantLayers = tag.variant_layers;
                }
                // reparent 标记（已在步骤 1 处理，这里只记录日志用）
                if (tag.reparent) {
                    node._reparentedTo = tag.reparent.new_parent;
                }
            }
            node.children?.forEach(apply);
        };

        nodes.forEach(apply);

        // 第二遍：对 _mergedNodes 里的节点，找到对应节点并标记 _mergedInto
        const allNodes = new Map<string, any>();
        const collectAll = (node: any) => {
            allNodes.set(node.id ?? node.sourceId, node);
            node.children?.forEach(collectAll);
        };
        nodes.forEach(collectAll);
    }

    /**
     * 执行 reparent 指令：
     *  1. 收集所有节点到 Map（含递归子节点）
     *  2. 按 reparent 指令将节点从原父节点移除，插入目标父节点
     *  3. 用 absoluteBoundingBox 做坐标系转换（相对→新父节点坐标系）
     *
     * 注意：reparent 只在原始 Figma 节点层（applyTags 入参）上操作，
     * 不涉及 UINode（UINode 在 RawFigmaParser 之后才构建）。
     */
    private reparentNodes(nodes: any[], tagMap: Map<string, NodeSemanticTag>): void {
        // 1. 构建全局 id → node 映射，同时记录 id → parent 映射
        const nodeMap    = new Map<string, any>();
        const parentMap  = new Map<string, any>(); // childId → parentNode

        const collect = (node: any, parent?: any) => {
            const id = node.id ?? node.sourceId;
            if (id) {
                nodeMap.set(id, node);
                if (parent) parentMap.set(id, parent);
            }
            node.children?.forEach((c: any) => collect(c, node));
        };
        nodes.forEach(n => collect(n, null));

        // 2. 找出所有需要 reparent 的节点
        const reparentTags = Array.from(tagMap.values()).filter(t => t.reparent);

        for (const tag of reparentTags) {
            const nodeId     = tag.node_id;
            const newParentId = tag.reparent!.new_parent;
            const role        = tag.reparent!.role;

            const node      = nodeMap.get(nodeId);
            const newParent = nodeMap.get(newParentId);
            const oldParent = parentMap.get(nodeId);

            if (!node) {
                console.warn(`⚠️  [reparent] 节点 ${nodeId} 不存在，跳过`);
                continue;
            }
            if (!newParent) {
                console.warn(`⚠️  [reparent] 目标父节点 ${newParentId} 不存在，跳过`);
                continue;
            }
            if (!newParent.children) newParent.children = [];

            // 3. 坐标转换：绝对坐标 → 相对新父节点
            const nodeBox   = node.absoluteBoundingBox;
            const parentBox = newParent.absoluteBoundingBox;
            if (nodeBox && parentBox) {
                // 保留原始绝对坐标备查
                node._originalAbsX = nodeBox.x;
                node._originalAbsY = nodeBox.y;
                // 写入相对坐标（Figma 节点用 relativeTransform，但我们直接改 x/y 供解析器读取）
                node._reparentRelX = Math.round(nodeBox.x - parentBox.x);
                node._reparentRelY = Math.round(nodeBox.y - parentBox.y);
                console.log(`🔀 [reparent] "${node.name}" (${nodeId}) → 父节点 "${newParent.name}" (${newParentId}), 相对坐标=(${node._reparentRelX},${node._reparentRelY})`);
            } else {
                console.warn(`⚠️  [reparent] "${node.name}" 缺少 absoluteBoundingBox，坐标无法自动转换`);
            }

            // 4. 从原父节点移除
            if (oldParent?.children) {
                const idx = oldParent.children.indexOf(node);
                if (idx !== -1) oldParent.children.splice(idx, 1);
            } else {
                // 原父节点是顶层（nodes 数组）
                const idx = nodes.indexOf(node);
                if (idx !== -1) nodes.splice(idx, 1);
            }

            // 5. 插入新父节点（插到末尾）
            newParent.children.push(node);

            // 6. 更新新父节点的 children_roles（如果 AI 指定了 role）
            if (role) {
                const parentTag = tagMap.get(newParentId);
                if (parentTag) {
                    if (!parentTag.children_roles) parentTag.children_roles = {};
                    parentTag.children_roles[nodeId] = role;
                }
            }

            // 7. 更新 parentMap
            parentMap.set(nodeId, newParent);
        }

        if (reparentTags.length > 0) {
            console.log(`✅ [reparent] 完成 ${reparentTags.length} 个节点的层级调整`);
        }
    }

    /**
     * Dry-run 模式：生成摘要文件供 IDE AI 分析，不调用 API。
     *
     * 新增：传入 figmaData 可提取 thumbnailUrl，在 prompt 中嵌入界面截图，
     * 让 AI 能同时看「图像」和「节点树」双重信息进行语义划分。
     *
     * reviseContext 不为空时，进入「修订模式」：prompt 会附加上次标注 + 人工反馈，
     * AI 在此基础上输出修订后的完整 semantic_tags.json。
     *
     * 输出文件：
     *   {packagePath}/ai_input_summary.json   → 节点摘要（depth≤5）
     *   {packagePath}/ai_input_prompt.md      → 完整 Prompt（含截图 URL + 节点摘要）
     */
    async dryRun(
        nodes: any[],
        packagePath: string,
        figmaData?: any,
        reviseContext?: { previousTags: string; feedback: string }
    ): Promise<string> {
        const { summaries, depthUsed } = buildSummaries(nodes);
        const summaryJson = JSON.stringify(summaries, null, 2);

        // 写摘要 JSON
        const summaryPath = path.join(packagePath, 'ai_input_summary.json');
        await fs.writeFile(summaryPath, summaryJson, 'utf-8');

        // ── 截图：优先复用本地缓存，首次下载后保存 ──────────────────────────
        const localThumbPath = path.join(packagePath, 'thumbnail.webp');
        let thumbnailUrl: string | undefined = figmaData?.thumbnailUrl;
        let localThumbExists = await fs.pathExists(localThumbPath);

        if (!localThumbExists && thumbnailUrl) {
            try {
                const resp = await axios.get(thumbnailUrl, { responseType: 'arraybuffer', timeout: 15000 });
                await fs.writeFile(localThumbPath, resp.data);
                localThumbExists = true;
                console.log(`🖼️  截图已缓存: ${localThumbPath}`);
            } catch (e: any) {
                console.warn(`⚠️  截图下载失败（将使用远端 URL）: ${e.message}`);
            }
        } else if (localThumbExists) {
            console.log(`🖼️  复用本地截图: ${localThumbPath}`);
            thumbnailUrl = undefined; // prompt 里改用本地路径引用
        }

        // prompt 里的截图引用：本地优先（相对路径），远端备用
        const thumbLines: string[] = localThumbExists ? [
            '## 界面截图',
            '',
            '> 请先查看此截图，理解整体视觉布局，再分析节点摘要：',
            '',
            `![界面截图](${localThumbPath})`,
            '',
        ] : thumbnailUrl ? [
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
        ];

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
            ...thumbLines,
            '## 分析重点',
            '',
            '请特别关注以下情况，需要准确识别：',
            '- **Toggle 开关**（含 Ellipse + Rectangle 的小组件，约 60-80px 高）→ 识别为 `Slider`，并标注 `bar`（轨道）和 `grip`（圆形滑块）子节点',
            '- **重复结构的多状态组件**（相同结构但填充色不同的多个实例）→ 识别为同一组件的变体，用 `state_pages` 标注开/关状态',
            '- **含 Mask 的容器**（如带圆角裁剪的卡片）→ 标注为 `Component`，**不要**标注为 `Image`，让代码决定是否 SSR',
            '- **导航菜单项**（图标 + 文字的重复单元）→ 识别为 `Label`，标注 `icon` 和 `title` 子节点',
            '- **选项卡按钮**（横向排列的多个按钮）→ 识别为 `Button`',
            '',
            '### 层级调整（reparent）判断',
            '',
            '请检查是否存在"层级放错了位置"的节点，典型情况：',
            '- **弹窗底部按钮栏**：与弹窗 Frame 同级，但 absoluteBoundingBox 在弹窗范围内 → `reparent` 到弹窗',
            '- **页面内的子面板**：某个 Frame 在视觉上是另一个大 Frame 的一部分，但 Figma 中是兄弟节点 → `reparent` 到大 Frame',
            '- **判断依据**：看 `w/h/xy` 是否完全落在目标父节点的范围内，且名称语义上有归属关系',
            '- 不确定时**不要** reparent，保持原始层级，在 risks 中说明',
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
            // ── 修订模式：附加上次标注 + 人工反馈 ──────────────────────────────
            ...(reviseContext ? [
                '',
                '---',
                '',
                '## ⚠️ 修订模式 — 请基于以下反馈修正标注',
                '',
                '上次生成的 XML 存在问题，人工反馈如下：',
                '',
                '```',
                reviseContext.feedback,
                '```',
                '',
                '### 上次的 semantic_tags.json（供参考，请在此基础上修正）',
                '',
                '```json',
                reviseContext.previousTags,
                '```',
                '',
                '**要求**：',
                '- 仅修改反馈中指出的问题节点，其余节点保持不变',
                '- 输出完整的 semantic_tags.json（包含未修改的节点）',
                '- 在修改的节点 risks 字段中注明修改原因',
            ] : []),
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
