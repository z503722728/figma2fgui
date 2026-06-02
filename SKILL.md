---
name: design2fgui
description: >
  Figma → FairyGUI 转换工具的 AI-skill 版本。
  在原 figma2fgui 代码管线基础上，引入：
  1. rules/ 外置规则（JSON 配置，不改代码即可调整映射关系）
  2. skill/ 模块文档（G01~G06，供 AI Agent 作为上下文读取）
  3. AISemanticTagger（可选，AI 预处理节点语义，降级到规则模式）
version: "0.1.0"
---

# design2fgui — Figma → FGUI 转换 Skill 路由

---

## 目录结构

```
design2fgui/
├── SKILL.md                        # 本文件：路由 + 调度策略
├── rules/                          # 外置规则（JSON，按项目覆盖）
│   ├── type-keywords.json          # 节点名关键词 → FGUI ObjectType
│   ├── naming-map.json             # 子节点角色 → 标准名称（title/icon/bar/grip）
│   ├── exclude-names.json          # 排除列表 + 背景检测 + 坐标阈值
│   ├── button-states.json          # Button 多状态页映射
│   └── pipeline-config.json        # 全局缩放、批次参数等
├── skill/                          # 模块文档（AI System Prompt 上下文）
│   ├── G01-global-rules.md         # 全局约束 + 红线（所有 Agent 必读）
│   ├── G02-colors-fills.md         # 颜色/填充/描边映射
│   ├── G03-typography-spacing.md   # 字体/间距/圆角
│   ├── G04-layout-coordinates.md   # 坐标系/展平/规范化
│   ├── G05-components.md           # 组件类型/子组件提取/多状态
│   └── G06-qc-handoff.md           # 验收 checklist + 冲突仲裁 + 回收 YAML
└── src/
    ├── rules/
    │   └── RuleLoader.ts           # 规则文件加载 + 快捷方法
    └── tagger/
        └── AISemanticTagger.ts     # AI 语义标注器（可选）
```

---

## 模块概览

| ID | 主题 | 文件 |
|---|---|---|
| G01 | 全局约束 / 红线 / AI 层说明 | [skill/G01-global-rules.md](./skill/G01-global-rules.md) |
| G02 | 颜色 / 填充 / 描边 / 渐变 | [skill/G02-colors-fills.md](./skill/G02-colors-fills.md) |
| G03 | 字体 / 间距 / 圆角 / 缩放 | [skill/G03-typography-spacing.md](./skill/G03-typography-spacing.md) |
| G04 | 坐标系 / 展平 / 规范化 / 旋转 | [skill/G04-layout-coordinates.md](./skill/G04-layout-coordinates.md) |
| G05 | 组件映射 / 提取 / 标准命名 / 多状态 | [skill/G05-components.md](./skill/G05-components.md) |
| G06 | 验收 / 冲突仲裁 / 回收 YAML | [skill/G06-qc-handoff.md](./skill/G06-qc-handoff.md) |

---

## 调度策略（根据任务类型选读模块）

| 任务 | 读哪些模块 |
|---|---|
| 调整组件类型识别规则 | G01 + **G05** → 修改 `rules/type-keywords.json` |
| 调整子节点命名规则 | G01 + **G05** → 修改 `rules/naming-map.json` |
| 调整颜色/填充处理 | G01 + **G02** |
| 调整字号/圆角缩放 | G01 + **G03** → 修改 `rules/pipeline-config.json` |
| 调整坐标/背景识别 | G01 + **G04** → 修改 `rules/exclude-names.json` |
| 调整 Button 多状态 | G01 + **G05** → 修改 `rules/button-states.json` |
| 完整转换流程 | G01 → G02 → G03 → G04 → G05 → G06 |
| 验收/排查问题 | **G06**（含冲突仲裁路由表） |
| AI 标注调优 | G01 + **G05**（修改 skill 文档即修改 AI System Prompt） |

### 推荐并行批次

- **批次 1（完全并行）**：G01 · G02 · G03
- **批次 2（依赖批次 1）**：G04 · G05
- **批次 3（依赖批次 1-2）**：G06（验收汇总）

---

## 规则 vs AI 双模式

```
有 AI_API_KEY                           无 AI_API_KEY / SKIP_AI_TAGGER=true
        ↓                                           ↓
AISemanticTagger                         rules/type-keywords.json
（语义理解，更准确）                      （关键词匹配，速度快）
        ↓                                           ↓
         └──────────────→ UINode.semanticType ←──────┘
                                  ↓
                     SubComponentExtractor（使用 semanticType）
                                  ↓
                              XMLGenerator
```

两条路径最终汇聚到同一管线，AI 失败时无缝降级，不中断流程。

---

## 冲突仲裁路由

| 冲突类型 | 仲裁模块 |
|---|---|
| 组件类型误判 | G05 → 更新 type-keywords.json |
| 子节点命名错误 | G05 → 更新 naming-map.json |
| 颜色/填充属性 | G02 |
| 坐标偏移/背景识别 | G04 → 更新 exclude-names.json |
| AI 标注不准确 | G05 → 在 skill 文档中补充项目约定 |
| 终审 | G06 |

---

## 全局红线摘要

- **规则外置**：一切可变规则存 `rules/` JSON，禁止在代码中硬编码映射关键词/阈值
- **确定性 ID**：Package ID = `{prefix}` + MD5(nodeId)，保证 FGUI 引用稳定
- **降级优雅**：AI 失败 → 规则模式；规则未命中 → Component 类型 + risks 日志
- **回收 YAML**：每次转换输出结构化决策日志，供 G06 验收和问题复现

详细约束进入对应模块查阅。
