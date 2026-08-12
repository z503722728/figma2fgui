

# design2fgui — Figma → FairyGUI AI 驱动转换引擎

将 Figma 云端设计稿转换为 FairyGUI (FGUI) 工程包。粘贴一个 Figma 链接，IDE AI 作为主 Agent 自动协调完成语义标注，输出可直接导入 FairyGUI 编辑器的 XML 包。

> **旧版（纯 CLI 规则模式）** 保存在 [`legacy-cli` 分支](../../tree/legacy-cli)。

---

## 🆕 相比旧版的核心升级

| 能力 | 旧版（legacy-cli） | 新版（本分支） |
|---|---|---|
| 语义标注 | 关键词规则匹配 | **AI 语义标注**（IDE AI 或 API） |
| 节点命名 | `Frame_24` 等机械名 | `btn_ClaimAll`、`nav_Panel` 等语义名 |
| 背景识别 | 关键词推断 | 精确配置 + 尺寸校验双重防御 |
| Image 处理 | 展开子节点 | **强制整体 SSR**，不生成空壳 XML |
| List 处理 | 生成独立 XML | **直接内联 `<list>`**，无空壳文件 |
| Label 复用 | 每个独立生成 | **同结构合并，title 通过 override 覆盖** |
| 截断检测 | 无提示 | Prompt 顶部警告表格 + 子 Agent 自动补全 |
| 自检简报 | 无 | `✅ 自检通过` 或列出异常项 |
| 分析/转换分离 | 单步 | `analyze` → 标注 → `convert-only` 两步 |

---

## 🚀 快速开始

### 1. 安装依赖

```bash
bun install
```

### 2. 配置 Token

```ini
# .env
FIGMA_TOKEN=figd_your_personal_access_token   # 必填
OUTPUT_PATH=./FGUIProject/assets              # 输出目录（可选）
```

> 获取 Token：[Figma Settings → Personal access tokens](https://www.figma.com/settings) → Generate new token（权限：File content: Read-only）

### 3. 使用方式

**唯一入口：将 Figma 链接粘贴给 IDE AI（推荐）**

IDE AI 作为主 Agent，自动完成以下全流程：
1. 调用 `bun run analyze <url>` 下载节点数据 + 生成摘要截图
2. 读取 `ai_input_prompt.md`，若有截断警告则派发 `code-explorer` 子 Agent 补全节点
3. 生成 `semantic_tags.json` 和 `project-rules.json`
4. 调用 `bun run convert-only <url>` 执行转换，输出 FGUI 包

> ⚠️ URL 中的 `&` 符号会被 shell 截断，使用简化格式：`https://www.figma.com/design/{fileKey}/x?node-id={nodeId}`

**纯规则模式（无需 AI 标注）**

```bash
bun run convert-only "https://www.figma.com/design/{fileKey}/name?node-id=88-3805"
```

---

## 📋 完整流程说明

```
bun run analyze <url>
        ↓
  下载 Figma 节点数据 + 节点预览截图（thumbnail.png）
  生成 ai_input_prompt.md（含截断警告表格）
  生成 ai_input_summary.json、figma_debug.json
        ↓
  [主 Agent 读取 ai_input_prompt.md]
  若有截断警告 → 派发 code-explorer 子 Agent 查询 figma_debug.json 补全缺失节点
        ↓
  生成 project-rules.json   ← 背景节点名、类型关键词覆盖等
  生成 semantic_tags.json   ← 每个节点的语义类型、fgui_name、children_roles
        ↓
bun run convert-only <url>
        ↓
  读取标注文件 → 解析 → 提取子组件 → 下载图片 → 生成 XML
        ↓
  📊 生成简报：N 个组件 XML，M 张图片资源
     ✅ 自检通过，无异常
```

---

## 🎛️ semantic_tags.json 字段说明

```json
[
  {
    "node_id": "88:3805",
    "semantic_type": "Component | Button | Label | List | Image | ComboBox | Slider | ProgressBar",
    "fgui_name": "语义化组件名（英文，无空格）",
    "children_roles": {
      "子节点ID": "bg | title | icon | bar | grip | ..."
    },
    "state_pages": { "0": "normal", "1": "on" },
    "reparent": {
      "new_parent": "目标父节点ID",
      "role": "在新父节点中的角色名（可选）"
    },
    "risks": ["不确定项说明"]
  }
]
```

### `semantic_type` 关键规则

| 类型 | 何时使用 |
|---|---|
| `Image` | 纯装饰背景/纹理层（**无文字、无按钮**子节点），整体 SSR 为一张 PNG |
| `Component` | 通用容器，让代码决定如何处理；含 Text/Button/List/Label 子节点时必须用此类型 |
| `Button` | 可点击按钮，配合 `state_pages` 标注多状态 |
| `Label` | 图标+文字菜单项，同结构自动合并复用，title 通过 override 覆盖 |
| `List` | 列表，直接内联 `<list>` 标签，不生成独立 XML |
| `Slider` | Toggle 开关（含 Ellipse 圆形滑块 + Rectangle 轨道），`children_roles`: 轨道→`bar`，滑块→`grip` |

> ⚠️ 含 Text/Button 子节点的容器**禁止**标注为 `Image`；含 Mask_group 子节点的容器标注为 `Component`，不是 `Image`

---

## 📐 架构概览

```
design2fgui/
├── SKILL.md                      # 主 Agent 入口（AI 使用规则文档）
├── skill/                        # 知识模块（G01~G06 规则文档）
│   ├── G01-global-rules.md       # 全局约束
│   ├── G02-colors-fills.md       # 颜色/填充
│   ├── G03-typography-spacing.md # 字体/圆角
│   ├── G04-layout-coordinates.md # 坐标系
│   ├── G05-components.md         # 组件映射规则
│   └── G06-qc-handoff.md         # 验收规范
├── src/
│   ├── analyze.ts              ← 第一步 CLI：下载数据 + 生成摘要
│   ├── convert-only.ts         ← 第二步 CLI：读取标注 + 执行转换
│   ├── index.ts                ← 核心管线（run() 函数）
│   ├── FigmaClient.ts          ← Figma REST API 客户端
│   ├── RawFigmaParser.ts       ← Figma JSON → UINode 树
│   ├── ImagePipeline.ts        ← SSR 图片批量下载（含视觉叶检测）
│   ├── Common.ts               ← 工具函数（sanitizeFileName 等）
│   ├── models/
│   │   ├── UINode.ts           ← 核心数据结构
│   │   └── FGUIEnum.ts         ← FGUI 组件类型枚举
│   ├── mapper/
│   │   └── PropertyMapper.ts   ← UINode 属性 → FGUI XML 属性（含 2x 缩放）
│   ├── generator/
│   │   ├── XMLGenerator.ts     ← 组件 XML / package.xml 生成
│   │   ├── SubComponentExtractor.ts  ← 子组件提取 + 多状态 + Label 合并
│   │   └── handlers/           ← 按节点类型分发的 XML 生成器
│   ├── tagger/
│   │   └── AISemanticTagger.ts ← AI 标注器（dry-run / API 模式）
│   └── utils/
│       └── parseFigmaUrl.ts    ← Figma URL 解析
└── rules/                      ← 外置规则 JSON（不改代码可调整行为）
```

---

## 🔧 调整规则（无需改代码）

所有转换规则外置在 `rules/` 目录：

| 文件 | 控制 |
|---|---|
| `rules/type-keywords.json` | 节点名关键词 → FGUI 组件类型 |
| `rules/naming-map.json` | 子节点角色 → 标准名称（`title`/`icon`/`bar`/`grip`） |
| `rules/exclude-names.json` | 排除列表 + 背景识别关键词 |
| `rules/button-states.json` | Button 多状态控制器页映射 |
| `rules/pipeline-config.json` | 缩放倍率、批次参数等 |

每个节点还可通过 `project-rules.json` **按项目覆盖**静态规则（由 AI 自动生成）：

```json
{
  "_note": "由 AI 根据本项目节点树动态生成，覆盖 rules/ 下的静态默认规则",

  "typeKeywords": {
    "Button":      ["AL3_/_HexTech_Glod", "AL3_/_HexTech_Blue"],
    "Slider":      ["Group_4613"],
    "Label":       ["nav_item"],
    "ProgressBar": [],
    "List":        []
  },

  "backgroundNodeNames": ["bg", "背景色", "Rectangle_1276"],

  "excludeFromExtraction": ["装饰性节点名称"],

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

---

## 📁 输出结构

```
FGUIProject/assets/Node_88_3805/
├── img/                         ← SSR 渲染图片（语义化命名）
│   ├── bg_scene_112_5767.png
│   ├── bg_1_152.png
│   └── ...
├── Page02.xml                   ← 根页面组件
├── btn_Play.xml                 ← 子组件
├── btn_HexGold.xml              ← 按钮（同结构复用）
├── btn_Bar.xml                  ← 按钮栏容器
├── ...（共 N 个 XML）
├── package.xml                  ← FGUI 包描述文件
├── thumbnail.png                ← 节点预览截图（analyze 阶段下载）
├── handoff.yaml                 ← AI 决策回收日志
├── semantic_tags.json           ← AI 标注结果
├── project-rules.json           ← 当前项目动态规则
├── ai_input_prompt.md           ← 分析任务文件（发给 IDE AI）
├── ai_input_summary.json        ← 节点摘要
└── figma_debug.json             ← Figma API 缓存
```

---

## ⚙️ .env 配置

> 推荐使用 IDE AI 作为主 Agent，只需填写 `FIGMA_TOKEN`，其余均为可选。

```ini
# ── 必填 ────────────────────────────────────────────────
FIGMA_TOKEN=figd_your_personal_access_token

# ── 可选 ─────────────────────────────────────────────────
OUTPUT_PATH=./FGUIProject/assets    # 默认 ./FGUIProject/assets

# ── 调试开关 ─────────────────────────────────────────────
FORCE_DOWNLOAD=false    # true = 强制重新下载所有图片（忽略缓存）
```

---

## 🔑 关键设计决策

### 视觉叶节点检测

`ImagePipeline.isVisualLeaf()` 判定是否整体 SSR：

1. `semanticType=Image`（AI 明确标注）→ **最高优先级，强制整体 SSR**
2. 节点类型为 `ObjectType.Image` → 直接渲染
3. 容器且所有后代均为形状节点 → 合并渲染
4. 含 Mask 后代 → 合并渲染

### Label 同结构复用

同结构的导航菜单项（仅 title 文字不同）自动合并为一个 XML 模板，在父组件中通过 `<Label title="..."/>` 覆盖，减少冗余文件。

### 背景节点识别（三层防御）

1. `project-rules.backgroundNodeNames` 精确指定 → 最高优先级，跳过尺寸校验
2. 关键词推断（`bg`、`background`、`底` 等）→ 要求面积 ≥ 容器 60%
3. 装饰词排除（`bg_texture`、`bg_highlight`、`bg_gradient` 等）→ 不作为 justify 基准

### 按钮 reparent

检查 `absoluteBoundingBox`：若按钮坐标超出其父节点范围（如被设计师放在背景装饰层的 children 里）→ 在 `semantic_tags.json` 中用 `reparent` 指定正确父容器。

### 全局 2x 缩放

所有坐标、尺寸、字号、描边统一 `× FGUI_SCALE(=2)` 输出，匹配高清资源。

---

## 🔄 导入后修复流程

```
导入 FairyGUI 后发现问题
        ↓
主 Agent 查看 handoff.yaml（决策日志）
        ↓
若需查询原始节点 → 派发 code-explorer 子 Agent 查询 figma_debug.json
定位问题节点 → 修改 semantic_tags.json 或 project-rules.json
        ↓
bun run convert-only <url>   ← 不需要重新下载，直接重跑转换
        ↓
验证修复
```

不需要修改代码，不需要重启，即改即跑。

---

## ⚠️ 注意事项

- **禁止在 FGUI 编辑器中点击「刷新」** — 会重置 `package.xml` 资源 ID，破坏引用。正确做法：关闭项目 → 重新打开。
- **摘要截断警告** — `analyze` 阶段若 prompt 顶部出现截断警告表格，主 Agent 必须派发 `code-explorer` 子 Agent 查询 `figma_debug.json` 补全缺失节点后再生成标注。
- **缓存机制** — Figma 数据缓存为 `figma_debug.json`，图片缓存到 `img/`。设置 `FORCE_DOWNLOAD=true` 强制刷新。
- **`figma_debug.json` 超 500KB** — 禁止直接读取，必须通过 `code-explorer` 子 Agent 精确查询。

---

## 🎬 测试设计稿

| 设计稿 | Figma 链接 | 核心测试点 |
|---|---|---|
| **LOL 风格游戏主界面** | [GAME UI Design In Figma](https://www.figma.com/community/file/1050752368690341429) | HexTech 按钮变体、复杂嵌套组件 |
| **UI 资源测试** | [UI Resource Test](https://www.figma.com/community/file/1401490605460822912) | List 内联、reparent、背景识别、Label 合并、ComboBox、Table |
