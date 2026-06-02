---
name: design2fgui
description: >
  Figma → FairyGUI (FGUI) 转换工具。
  用户提供 Figma 链接，AI（你）作为主 Agent 协调两个子 Agent 完成转换：
  1. AnalyzeAgent：下载节点树 + 界面截图，动态生成 project-rules.json
  2. ConvertAgent：根据动态规则执行转换，生成 FGUI XML 包
  
  整个流程在 IDE 内完成，无需手动编辑配置文件。
version: "1.0.0"
---

# design2fgui — IDE AI 驱动的 Figma → FGUI 转换

> **唯一入口**：用户粘贴 Figma 链接给 IDE AI，其余全部自动完成。

---

## 你（主 Agent）的职责

收到 Figma URL 后，按以下顺序执行：

### 第一步：调用 AnalyzeAgent

```bash
bun run analyze <figma_url>
```

这会生成：
- `{output}/ai_input_summary.json` — 节点树摘要（depth≤5）
- `{output}/ai_input_prompt.md` — 含界面截图 URL + 分析任务
- `{output}/figma_debug.json` — 原始 Figma 数据缓存

**然后你读取 `ai_input_prompt.md`**（含截图 + 节点摘要），分析 UI 结构，生成 `project-rules.json` 和 `semantic_tags.json`，保存到同一目录。

### 第二步：调用 ConvertAgent

```bash
bun run convert-only <figma_url>
```

读取第一步生成的两个文件，执行转换，输出 FGUI 包。

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
    "semantic_type": "Button | Slider | Label | Component | ...",
    "fgui_name": "语义化组件名（英文，无空格）",
    "children_roles": {
      "子节点ID": "title | icon | bar | grip | bg"
    },
    "state_pages": { "0": "normal", "1": "on/hover/..." },
    "risks": ["不确定的地方"]
  }
]
```

---

## 分析时的关键判断规则

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
- 背景节点是面积最大、覆盖整个组件的底层矩形/图形
- **不要**把按钮、装饰元素误标为背景

### 重复组件合并
- 相同结构的多个实例 → 提取为同一组件，在 `componentGroups` 中描述
- 颜色/状态差异 → `state_pages` 多状态，不是多个不同组件

---

## 转换管线工作原理

```
bun run analyze <url>
        ↓
  下载 Figma 数据 + 生成摘要文件
        ↓
  [你在 IDE 里读 ai_input_prompt.md]
  看截图 + 看节点摘要 → 理解 UI 结构
        ↓
  生成 project-rules.json   ← 动态覆盖 rules/*.json
  生成 semantic_tags.json   ← 节点语义标注
        ↓
bun run convert-only <url>
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
你（IDE AI）查看 handoff.yaml（决策日志）
        ↓
定位问题节点 → 修改 semantic_tags.json 或 project-rules.json
        ↓
bun run convert-only <url>   ← 不需要重新下载，直接重跑转换
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
    ├── analyze.ts                # AnalyzeAgent CLI（bun run analyze）
    ├── cli.ts                    # ConvertAgent CLI（bun run convert-only）
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
