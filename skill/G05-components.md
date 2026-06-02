---
module_id: G05
owns: [FGUI 组件类型映射, 子组件提取规则, 扩展组件标准命名, 多状态控制器]
inputs_from: [G01, G02, G03, G04]
outputs_to: [G06]
version: "0.1.0"
---

# G05 — 组件映射 / 子组件提取 / 多状态

---

## 一、Figma 节点类型 → FGUI ObjectType

### 基础类型（固定映射）

| Figma type | FGUI ObjectType | 处理方式 |
|---|---|---|
| TEXT | Text | TextHandler |
| VECTOR / STAR / REGULAR_POLYGON / BOOLEAN_OPERATION | Image | 强制 SSR |
| RECTANGLE / ELLIPSE（无子节点） | Graph | GraphHandler |

### 容器类型（关键词优先，见 rules/type-keywords.json）

**判断顺序**：AI semanticType → type-keywords.json 关键词匹配 → 默认 Component

| 匹配关键词示例 | FGUI ObjectType | FGUI 扩展类型 |
|---|---|---|
| button / btn / clickable | Button | Button |
| progress / progressbar | ProgressBar | ProgressBar |
| slider / range | Slider | Slider |
| combo / select / dropdown | ComboBox | ComboBox |
| list / listview / scroll | List | List |
| label | Label | Label |
| 其他 FRAME/INSTANCE/GROUP | Component | — |

> `rules/type-keywords.json` 中的 `exclude` 字段防止误匹配（如 `listitem` 不应匹配 List）。

---

## 二、子组件提取规则（SubComponentExtractor）

### 提取候选判断（"显著性"条件，OR 关系）

```
children.length > rules.pipeline.componentExtraction.minChildrenToExtract
  OR  isExtensionType（Button / ProgressBar / Slider / ComboBox / Label / List）
  OR  hasNestedExtracted（含已提取的子组件）
  OR  hasVisuals && children.length > 0
```

### 排除规则

- 名称关键词命中 `rules/exclude-names.json → componentExtraction.keywords`
- 纯形状组（所有后代均为 Image/Graph）→ 整体 SSR，不提取
- 含 `isMask` 后代的非扩展类型 → 整体 SSR

### 结构哈希（用于识别多实例）

哈希输入：`type + width + height + borderRadius + border + strokeSize + shadow + fillType`  
故意忽略：颜色、文本内容（颜色差异作为多状态处理，文字差异不影响结构复用）

---

## 三、扩展组件标准命名（applyStandardNaming）

FGUI 扩展组件**强制要求**特定子节点名称，否则功能失效。

规则来源：`rules/naming-map.json`，逻辑：`matchStandardName(childName, childType, parentType)`

| 标准名称 | 适用父类型 | 条件 |
|---|---|---|
| `title` | Button / Label / ProgressBar / Slider / ComboBox | Text 节点 + 名称含 label/title/text 等 |
| `icon` | Button / Label | Image/Graph/Component + 名称含 icon/img 等；自动转为 Loader 类型 |
| `bar` | ProgressBar / Slider | Image/Graph/Component + 名称含 bar/progress/fill 等 |
| `grip` | Slider | Image/Graph/Component + 名称含 grip/thumb/handle 等 |

---

## 四、多状态控制器（Button gearIcon）

### 状态页映射（rules/button-states.json）

```
页 0 = normal/up/default
页 1 = pressed/down/clicked
页 2 = hover/over/focus
页 3 = selected/checked/active
页 4 = disabled/grayed/inactive
```

### gearIcon 格式

```
{base}|{variant}|{base}|{base}
```

含义：up状态图片 | down状态图片 | over状态图片（复用up） | selected状态图片（复用up）

> 超过 2 个变体时，由 AI 语义标注器（AISemanticTagger）推断完整状态序列。  
> 无 AI 时，仅处理第一个识别到的变体，其余写入 risks。

---

## 五、图标 / 图集（资源引用）

- Figma INSTANCE 节点（来自组件库的图标）→ 优先整体 SSR，不展开内部结构
- FGUI gearIcon URL 格式：`ui://{packageId}{resId}`（无斜杠分隔）
- 资源 ID 格式：`img_` + sanitizedNodeId
