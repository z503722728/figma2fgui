---
name: design2fgui
description: >
  Figma → FairyGUI (FGUI) 转换工具。
  用户提供 Figma 链接，AI（你）作为主 Agent 协调子 Agent 完成转换：
  1. AnalyzeAgent（CLI）：下载节点树 + 界面截图，生成摘要文件
  2. 主 Agent（你）：读取摘要 + 截图，调用 code-explorer 子 Agent 补全截断节点，生成 semantic_tags.json 和 project-rules.json
  3. ConvertAgent（CLI）：根据标注文件执行转换，生成 FGUI XML 包
  
  整个流程在 IDE 内完成，无需手动编辑配置文件。
version: "1.1.0"
---

# design2fgui — IDE AI 驱动的 Figma → FGUI 转换

> **唯一入口**：用户粘贴 Figma 链接给 IDE AI，其余全部自动完成。

---

## 你（主 Agent）的职责

收到 Figma URL 后，按以下顺序执行：

### 第一步：调用 AnalyzeAgent（CLI）

```bash
bun src/analyze.ts <figma_url>
```

> ⚠️ 必须在 design2fgui 项目目录下执行，URL 中的 `&` 符号会被 shell 截断，使用简化 URL 格式：
> `https://www.figma.com/design/{fileKey}/x?node-id={nodeId}`

这会生成：
- `{output}/ai_input_summary.json` — 节点树摘要（depth≤5，可能有截断）
- `{output}/ai_input_prompt.md` — 含界面截图 + 分析任务 + **截断警告**
- `{output}/figma_debug.json` — 原始 Figma 数据缓存（完整节点树）
- `{output}/thumbnail.png` — 节点预览截图

### 第二步：读取 prompt + 处理截断节点

**你读取 `ai_input_prompt.md`**，其中可能包含截断警告表格，例如：

```
| `2:1293` | 主体 | **5 个子节点未显示** |
```

遇到截断时，**立即派发 code-explorer 子 Agent** 查询被截断节点的完整子节点：

```
Task(subagent_name="code-explorer", prompt="
  读取 {output}/figma_debug.json，找到节点 ID 为 '2:1293' 的节点，
  列出其所有直接子节点的 id、name、type、absoluteBoundingBox（width/height/x/y）。
  同时检查每个子节点是否包含 children，如有则列出第一层子节点。
  不需要读取其他文件。
")
```

子 Agent 返回完整子节点列表后，结合截图和摘要中已有信息，生成完整标注。

### 第三步：生成标注文件

生成两个文件并保存到同一目录：

**`project-rules.json`**（覆盖静态规则）和 **`semantic_tags.json`**（节点语义标注）

详见下方"产出规范"章节。

### 第四步：调用 ConvertAgent（CLI）

```bash
bun src/convert-only.ts https://www.figma.com/design/{fileKey}/x?node-id={nodeId}
```

读取第三步生成的两个文件，执行转换，输出 FGUI 包。

---

## 何时使用子 Agent（code-explorer）

以下情况必须派发 code-explorer 子 Agent，不要自己读取大文件：

| 情况 | 子 Agent 任务 |
|---|---|
| `ai_input_prompt.md` 中出现截断警告 | 查询 `figma_debug.json` 中被截断父节点的完整 children |
| 某节点的 `absoluteBoundingBox` 坐标超出其父节点范围 | 查询该节点及其父节点的坐标，判断是否需要 reparent |
| 需要确认某节点是否含有 Text/Button 等特殊子孙节点 | 深度查询指定节点的子孙节点类型 |
| `figma_debug.json` 体积超过 500KB | 禁止直接 read_file，必须通过子 Agent 精确查询 |

**子 Agent 调用模板**：
```
Task(
  subagent_name="code-explorer",
  prompt="读取 {绝对路径}/figma_debug.json，[具体查询任务]。只输出所需字段，不读取其他文件。"
)
```

---

## AnalyzeAgent 产出规范

你分析完 `ai_input_prompt.md` 后，需要生成两个文件：

### 1. `project-rules.json` — 当前项目的动态规则

```json
{
  "_note": "由 AI 根据本项目节点树动态生成，覆盖 rules/ 下的静态默认规则",
  
  "typeKeywords": {
    "Button":      ["你在此项目中发现的按钮命名模式"],
    "Slider":      ["你发现的 Toggle/开关命名模式，如 Group_4613"],
    "Label":       ["导航菜单项命名模式"],
    "ProgressBar": [],
    "List":        []
  },
  
  "backgroundNodeNames": ["bg", "背景色", "Rectangle_1276"],
  
  "excludeFromExtraction": ["装饰性节点名称，不应被提取为独立组件"],
  
  "componentGroups": [
    {
      "_note": "描述一组结构相同的重复组件实例",
      "pattern": "Group_4613",
      "semanticType": "Slider",
      "states": {
        "on":  { "fillColor": "#00C853" },
        "off": { "fillColor": "#9E9E9E" }
      }
    }
  ],
  
  "coordZeroThreshold": 3.5,
  "scale": 2
}
```

### 2. `semantic_tags.json` — 节点语义标注

```json
[
  {
    "node_id": "节点ID",
    "semantic_type": "Button | Slider | Label | Component | Image | ...",
    "fgui_name": "语义化组件名（英文，无空格）",
    "children_roles": {
      "子节点ID": "title | icon | bar | grip | bg"
    },
    "state_pages": { "0": "normal", "1": "on/hover/..." },
    "reparent": { "new_parent": "目标父节点ID", "role": "可选角色名" },
    "risks": ["不确定的地方"]
  }
]
```

---

## 分析时的关键判断规则

### `semantic_type: "Image"` 使用规范（重要）

**应标注为 `Image`**（代码会强制整体 SSR 成一张 PNG）：
- 纯装饰性背景层（星形/几何图案叠加、**无文字、无按钮**子节点）
- 含 Mask 遮罩但无交互内容的装饰层
- 版权标注栏等重复装饰结构

**禁止标注为 `Image`**，应标注为 `Component`：
- 含文字（Text）子节点
- 含按钮/图标等可交互子节点
- 含 List/Label/Button 等扩展组件子节点

### Toggle 开关识别
- 形态：含 `Ellipse`（圆形滑块）+ `Rectangle`（轨道）的小组件（高度约 30-80px）
- 多个同名实例但颜色不同（绿色=开，灰色=关）→ 识别为 `Slider`
- 标注 `children_roles`：轨道 → `bar`，圆形滑块 → `grip`
- **不要**整体 SSR，要识别为可交互组件

### 含 Mask 的容器
- 含 `Mask_group` 子节点的容器 → 标注为 `Component`，**不是 Image**
- 让管线决定 mask 内部如何处理

### 导航菜单项
- 重复的「图标 + 文字」单元 → `Label`
- 选中态（高亮背景）与普通态 → 同一组件的不同状态，用 `state_pages` 标注

### 背景节点（坐标原点）
- 明确列出哪些节点是背景节点（名称放入 `backgroundNodeNames`）
- 背景节点是面积最大、覆盖整个组件的底层矩形/图形（面积 ≥ 容器 60%）
- **不要**把局部装饰层、header 误标为背景

### 按钮藏在装饰层内（reparent）
- 检查 `absoluteBoundingBox`：若按钮坐标超出其父 Mask_group 范围 → `reparent` 到正确的父容器
- 典型场景：底部按钮栏被设计师放在背景装饰层的 children 里

---

## 转换管线工作原理

```
bun src/analyze.ts <url>
        ↓
  下载 Figma 数据 + 生成摘要文件（含截断警告）
        ↓
  [主 Agent 读 ai_input_prompt.md]
  若有截断警告 → 派发 code-explorer 子 Agent 查询 figma_debug.json
        ↓
  生成 project-rules.json   ← 动态覆盖 rules/*.json
  生成 semantic_tags.json   ← 节点语义标注
        ↓
bun src/convert-only.ts <url>
        ↓
  读取 project-rules.json + semantic_tags.json
  执行转换：解析 → 提取子组件 → 下载图片 → 生成 XML
        ↓
  输出 FGUI 包（可直接导入 FairyGUI 编辑器）
```

---

## 出现问题时的修正流程

```
导入 FairyGUI 后发现问题
        ↓
主 Agent 查看 handoff.yaml（决策日志）
        ↓
若需要查询原始节点 → 派发 code-explorer 子 Agent 查询 figma_debug.json
定位问题节点 → 修改 semantic_tags.json 或 project-rules.json
        ↓
bun src/convert-only.ts <url>   ← 不需要重新下载，直接重跑转换
        ↓
验证修复
```

不需要修改代码，不需要重启，即改即跑。

---

## 项目目录结构

```
design2fgui/
├── SKILL.md                      # 本文件（主 Agent 入口）
├── skill/                        # 知识模块（你需要读的规则文档）
│   ├── G01-global-rules.md       # 全局约束（必读）
│   ├── G02-colors-fills.md       # 颜色/填充
│   ├── G03-typography-spacing.md # 字体/圆角
│   ├── G04-layout-coordinates.md # 坐标系
│   ├── G05-components.md         # 组件映射规则
│   └── G06-qc-handoff.md         # 验收规范
├── rules/                        # 静态默认规则（被 project-rules.json 动态覆盖）
│   ├── pipeline-config.json      # scale、批次参数等（通常不需要覆盖）
│   └── ...
└── src/
    ├── analyze.ts                # AnalyzeAgent CLI（bun src/analyze.ts）
    ├── convert-only.ts           # ConvertAgent CLI（bun src/convert-only.ts）
    └── index.ts                  # 核心转换管线（run() 函数）
```

---

## 环境配置（仅需一次）

在 `.env` 中填写 Figma Token：

```ini
FIGMA_TOKEN=figd_your_personal_access_token
OUTPUT_PATH=./FGUIProject/assets   # 可选
```

> Token 获取：[Figma Settings → Personal access tokens](https://www.figma.com/settings)  
> 权限：File content: Read-only
