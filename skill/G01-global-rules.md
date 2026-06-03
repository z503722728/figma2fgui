---
module_id: G01
owns: [全局约束, 红线规则, 命名规范, 资源路径约定]
inputs_from: []
outputs_to: [G02, G03, G04, G05]
version: "0.2.0"
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

## 三、AI 语义标注层（semantic_tags.json）

当配置了 `AI_API_KEY` 且 `SKIP_AI_TAGGER != true` 时，管线会在 RawFigmaParser 之后插入 AI 预处理：

```
Figma JSON → [AISemanticTagger] → RawFigmaParser → SubComponentExtractor → XMLGenerator
```

AI 读取 `skill/G01` + `skill/G05` 作为 System Prompt，为每个节点输出 `semantic_tags.json`，支持以下字段：

| 字段 | 说明 |
|---|---|
| `node_id` | Figma 节点 ID |
| `semantic_type` | FGUI ObjectType（Button/List/Component/Image 等） |
| `fgui_name` | 语义化组件名（替换 Frame_24 等机械名称） |
| `button_mode` | Button 工作模式：Common / Check / Radio |
| `children_roles` | 子节点角色映射：node_id → 标准名（title/icon/bg/bar/grip...） |
| `list_item_template` | List 的 item template 名称 |
| `list_item_node_id` | List 的 item template 精确节点 ID（优先于名称查找） |
| `variant_layers` | 多变体图层（state controller + gearIcon 换图，见 G05） |
| `reparent` | 节点层级调整（移入新父节点，坐标自动转换，见 G04） |
| `risks` | 不确定项（写入 handoff.yaml 供人工复查） |

**AI 失败时自动降级**到 `rules/type-keywords.json` 关键词匹配模式，不影响流程。

---

## 四、节点语义命名（children_roles 驱动）

AI 在 `children_roles` 里填写子节点角色名后，生成的 XML 节点 `name` 属性自动使用角色名（而非 `n0/n1/n2` 自增 ID）。

- **有角色名** → `name="bg_panel"`、`name="btn_ArrowLeft"` 等
- **无角色名** → `name="n0"`（自增 ID）
- **去重处理** → 同组件内同名角色自动追加 `_2`、`_3` 后缀

---

## 五、冲突仲裁路由

| 冲突类型 | 仲裁模块 |
|---|---|
| 颜色/填充属性映射 | G02 |
| 字体/间距/圆角映射 | G03 |
| 布局/层级/坐标系 | G04 |
| 组件类型/图标/资源引用 | G05 |
| 终审/验收 | G06 |
