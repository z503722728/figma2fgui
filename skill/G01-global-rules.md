---
module_id: G01
owns: [全局约束, 红线规则, 命名规范, 资源路径约定]
inputs_from: []
outputs_to: [G02, G03, G04, G05]
version: "0.1.0"
---

# G01 — 全局约束与红线规则

> 所有模块和所有 Agent 任务都必须先读本文件。

---

## 一、核心理念：规则外置，不写死代码

**旧方式（figma2fgui）**：类型判断、命名映射、阈值常量全部硬编码在 TypeScript 文件里。  
**新方式（design2fgui）**：所有可变规则存放在 `rules/` 目录的 JSON 文件中，代码只读规则、不包含规则值。

| 规则文件 | 管辖范围 |
|---|---|
| `rules/type-keywords.json` | 节点名关键词 → FGUI ObjectType |
| `rules/naming-map.json` | 子节点语义 → FGUI 标准名称（title/icon/bar/grip） |
| `rules/exclude-names.json` | 排除列表 + 背景检测关键词 + 坐标归零阈值 |
| `rules/button-states.json` | Button 多状态控制器页映射 |
| `rules/pipeline-config.json` | 全局缩放、批次参数、Loader 填充模式等 |

**修改规则时只需编辑对应 JSON 文件，不需要动代码，不需要重新编译。**

---

## 二、五条红线（任何场景不得违反）

1. **禁止在代码中硬编码规则值**  
   节点名关键词、阈值数字、映射字典 → 统一走 `rules/` JSON。  
   代码里唯一允许的 fallback 是读取 JSON 失败时的默认值（且必须有日志警告）。

2. **命名规范**  
   - FGUI 组件名：ASCII字母/数字/下划线，无中文、无空格、无特殊字符  
   - 扩展组件子节点：必须使用标准名称（`title` / `icon` / `bar` / `grip`），见 `rules/naming-map.json`  
   - 资源文件名：`{sanitizedName}_{nodeId}.png`，其中 `:` 替换为 `_`

3. **坐标系约定**  
   - 所有输出坐标已乘以 `scale`（见 `pipeline-config.json`，默认 2）  
   - 组件内部坐标以背景节点左上角为原点（`justifyComponentLayout` 负责规范化）  
   - 浮点偏移小于 `coordZeroThreshold.px` 直接归零

4. **图片资源路径**  
   - SSR 图片统一存放于 `{packagePath}/img/` 目录  
   - `package.xml` 中图片路径格式：`img/{filename}.png`  
   - 禁止使用绝对路径或网络 URL 作为 FGUI 资源路径

5. **Package ID 确定性**  
   - Package ID = `{prefix}` + MD5(figmaNodeId)[0:length]  
   - 参数见 `pipeline-config.json.packageId`  
   - 保证同一 Figma 节点每次生成相同 ID，不破坏 FGUI 工程中的资源引用关系

---

## 三、AI 语义标注层（可选）

当配置了 `AI_API_KEY` 且 `SKIP_AI_TAGGER != true` 时，管线会在 RawFigmaParser 之后插入 AI 预处理：

```
Figma JSON → RawFigmaParser → [AISemanticTagger] → SubComponentExtractor → XMLGenerator
```

AI 读取 `skill/G01` + `skill/G05` 作为 System Prompt，为每个节点输出：
- `semanticType`：FGUI ObjectType（比关键词匹配更准确）
- `childrenRoles`：子节点标准角色
- `statePages`：多状态变体识别
- `risks`：不确定项（写入回收 YAML）

**AI 失败时自动降级**到 `rules/type-keywords.json` 关键词匹配模式，不影响流程。

---

## 四、冲突仲裁路由

| 冲突类型 | 仲裁模块 |
|---|---|
| 颜色/填充属性映射 | G02 |
| 字体/间距/圆角映射 | G03 |
| 布局/层级/坐标系 | G04 |
| 组件类型/图标/资源引用 | G05 |
| 终审/验收 | G06 |
