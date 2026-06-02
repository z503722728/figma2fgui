# design2fgui

**Figma 设计稿 → FairyGUI (FGUI) UI 包** 一键转换工具。

粘贴一个 Figma 链接，自动完成：节点解析 → AI 语义标注 → 图片下载 → XML 生成。

---

## 快速开始

### 1. 安装依赖

```bash
bun install
```

### 2. 配置 Token

复制 `.env.example` 为 `.env`，填入 Figma Personal Access Token：

```bash
cp .env.example .env
```

```ini
# .env
FIGMA_TOKEN=figd_your_personal_access_token   # 必填
OUTPUT_PATH=./FGUIProject/assets              # 输出目录（可选）
```

> 获取 Token：[Figma Settings → Personal access tokens](https://www.figma.com/settings) → Generate new token（权限选 File content: Read-only）

### 3. 粘贴 Figma 链接，一键转换

```bash
bun run convert "https://www.figma.com/design/MkXcjtn8mj33vXj0eoOr7u/GameUI?node-id=1-1083"
```

转换完成后，把输出目录导入 FairyGUI 编辑器即可。

---

## 用法详解

### 命令格式

```bash
bun run convert <figma_url> [output_path]
```

| 参数 | 说明 |
|---|---|
| `figma_url` | Figma 设计稿链接（必填） |
| `output_path` | FGUI 包输出目录（可选，默认读 `.env` 的 `OUTPUT_PATH`） |

### 示例

```bash
# 转换指定节点
bun run convert "https://www.figma.com/design/abc123/GameUI?node-id=88-3805"

# 指定输出目录
bun run convert "https://www.figma.com/design/abc123/GameUI?node-id=88-3805" ./output

# 转换整个文件（不指定 node-id）
bun run convert "https://www.figma.com/design/abc123/GameUI"
```

### 支持的 Figma URL 格式

```
https://www.figma.com/design/{fileKey}/{name}?node-id={nodeId}
https://www.figma.com/file/{fileKey}/{name}?node-id={nodeId}
https://www.figma.com/proto/{fileKey}/{name}?node-id={nodeId}
```

> `node-id` 参数中的 `-`（如 `1-1083`）会自动转换为 Figma API 要求的 `:`（`1:1083`）。

---

## AI 语义标注

默认使用 `rules/*.json` 关键词匹配识别组件类型（无需 AI 配置）。

开启 AI 标注后，组件名称从 `Frame_24` 变为 `col_HexTechGold_Wide` 等有意义的名称。

### 方式 A：IDE AI 手动标注（推荐，无需 API Key）

```bash
# 第一步：生成摘要文件（约 8KB，从 3MB 原始 JSON 压缩而来）
AI_DRY_RUN=true bun run convert "https://..."
# 或
bun run dry-run "https://..."
```

生成两个文件：
- `{output}/ai_input_summary.json` — 发给 AI 的节点摘要
- `{output}/ai_input_prompt.md` — 完整 Prompt（含规则上下文）

**第二步**：在 IDE 中把 `ai_input_prompt.md` 发给 AI 助手（@文件 引用），获得 JSON 结果。

**第三步**：将 AI 返回的 JSON 保存为 `{output}/semantic_tags.json`。

**第四步**：重新运行转换命令，自动读取标注结果：

```bash
bun run convert "https://..."
```

### 方式 B：自动 API 调用

在 `.env` 中配置：

```ini
AI_API_KEY=sk-your-api-key
AI_API_BASE=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
```

### 标注结果格式（`semantic_tags.json`）

```json
[
  {
    "node_id": "1339:6408",
    "semantic_type": "Component",
    "fgui_name": "col_HexTechGold_Icon",
    "children_roles": {
      "1339:6409": "btn_Cash",
      "1339:6410": "btn_Crystal"
    },
    "state_pages": { "0": "normal", "1": "hover" },
    "risks": []
  },
  {
    "node_id": "1339:6409",
    "semantic_type": "Button",
    "fgui_name": "Btn_HexTechGold_Cash",
    "children_roles": {},
    "state_pages": { "0": "normal", "1": "hover" },
    "risks": []
  }
]
```

---

## 调整规则（不改代码）

所有转换规则外置在 `rules/` 目录，按需修改 JSON 文件：

| 文件 | 控制 |
|---|---|
| `rules/type-keywords.json` | 节点名关键词 → FGUI 组件类型 |
| `rules/naming-map.json` | 子节点角色 → 标准名称（`title`/`icon`/`bar`/`grip`） |
| `rules/exclude-names.json` | 排除列表 + 背景识别关键词 + 坐标归零阈值 |
| `rules/button-states.json` | Button 多状态控制器页映射 |
| `rules/pipeline-config.json` | 缩放倍率、批次参数、Loader 填充模式等 |

### 常见调整

**识别不到按钮（命名不规范）** → `rules/type-keywords.json`：
```json
"Button": {
  "keywords": ["button", "btn", "clickable", "你的项目命名"]
}
```

**子节点没被命名为 `title`** → `rules/naming-map.json`：
```json
"title": {
  "match": ["label", "title", "文本", "你用的名字"]
}
```

**坐标偏移归零阈值太大/太小** → `rules/exclude-names.json`：
```json
"coordZeroThreshold": { "px": 3.5 }
```

**需要 1x 输出** → `rules/pipeline-config.json`：
```json
"scale": { "value": 1 }
```

---

## 输出结构

```
FGUIProject/assets/Node_88-3805/
├── img/                        ← SSR 渲染图片（语义化命名）
│   ├── bg_112_5767-112_5566.png
│   ├── icon_7_61-172_2273.png
│   └── ...
├── Page_GameUI.xml             ← 根页面组件
├── Bg_Page.xml                 ← 子组件
├── Btn_HexTechGold_Cash.xml    ← 按钮变体
├── col_HexTechGold_Icon.xml    ← 按钮容器列
├── ...（共 N 个 XML）
├── package.xml                 ← FGUI 包描述文件
├── handoff.yaml                ← AI 决策回收日志（有 AI 标注时生成）
├── semantic_tags.json          ← AI 标注结果（手动/自动生成后放置）
├── ai_input_summary.json       ← Dry-run 生成的节点摘要
└── figma_debug.json            ← Figma API 缓存（避免重复请求）
```

---

## .env 完整配置说明

```ini
# ── 必填 ────────────────────────────────────────────────
FIGMA_TOKEN=figd_your_personal_access_token

# ── 可选（也可通过命令行参数传入） ────────────────────────
FIGMA_FILE_KEY=rrkjikmTdpPpHJeYcMhR7n   # bun run start 模式使用
FIGMA_NODE_ID=88-3805                    # bun run start 模式使用
OUTPUT_PATH=./FGUIProject/assets

# ── AI 语义标注（全部可选） ─────────────────────────────────
# 方式 A [手动]: 把 semantic_tags.json 放入输出目录，自动读取
# 方式 B [API]:  填写 AI_API_KEY，自动调用
# 方式 C [Dry]:  设置 AI_DRY_RUN=true，生成摘要给 IDE AI 处理
# 方式 D [规则]: 以上均不配置，使用 rules/*.json 关键词匹配
AI_API_KEY=sk-your-api-key
AI_API_BASE=https://api.openai.com/v1
AI_MODEL=gpt-4o-mini
AI_BATCH_SIZE=20        # 每批发给 AI 的顶层节点数
AI_DRY_RUN=false

# ── 调试开关 ────────────────────────────────────────────
FORCE_DOWNLOAD=false    # true = 强制重新下载所有图片
SKIP_AI_TAGGER=false    # true = 跳过 AI，只用规则模式
```

---

## 项目结构

```
design2fgui/
├── src/
│   ├── cli.ts                  ← CLI 入口（URL 模式）
│   ├── index.ts                ← 核心管线（run() 函数）
│   ├── FigmaClient.ts          ← Figma REST API 客户端
│   ├── RawFigmaParser.ts       ← Figma JSON → UINode 树
│   ├── ImagePipeline.ts        ← SSR 图片批量下载
│   ├── Common.ts               ← 工具函数
│   ├── models/                 ← 数据模型
│   ├── generator/              ← XML 生成（SubComponentExtractor / XMLGenerator / Handlers）
│   ├── mapper/                 ← 属性映射（PropertyMapper）
│   ├── rules/                  ← 规则加载器（RuleLoader）
│   ├── tagger/                 ← AI 语义标注器（AISemanticTagger）
│   └── utils/
│       └── parseFigmaUrl.ts    ← Figma URL 解析
├── rules/                      ← 外置规则（JSON，按项目覆盖）
├── skill/                      ← AI 上下文文档（G01~G06）
├── .env.example
└── package.json
```

---

## 常见问题

**Q: 报 403 Forbidden**
Token 已过期，重新在 [Figma Settings](https://www.figma.com/settings) 生成并更新 `.env`。

**Q: 图片下载后是空白**
设置 `FORCE_DOWNLOAD=true` 重跑一次，强制刷新缓存。

**Q: 组件名称还是 Frame_24 这样的机械名**
使用 AI 标注（参考上方「AI 语义标注」章节），在 `semantic_tags.json` 中指定 `fgui_name` 字段。

**Q: 想修改组件类型识别规则**
编辑 `rules/type-keywords.json`，无需修改代码。

**Q: 大文件报超时**
调整 `rules/pipeline-config.json` 中的 `imagePipeline.batchDelayMs` 增加批次间隔。
