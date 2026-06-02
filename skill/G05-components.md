---
module_id: G05
owns: [FGUI 组件类型映射, 子组件提取规则, 扩展组件标准命名, 多状态控制器, Button 模式]
inputs_from: [G01, G02, G03, G04]
outputs_to: [G06]
version: "1.1.0"
---

# G05 — 组件映射 / 子组件提取 / 多状态

---

## 一、FGUI 完整组件类型（ObjectType）

| ID | 名称 | 说明 | 转换来源 |
|---|---|---|---|
| 0 | **Image** | 静态图片 | VECTOR/STAR/矢量形状，整体 SSR |
| 1 | MovieClip | 序列帧动画 | `.jta` 资源 |
| 3 | **Graph** | 纯色/渐变矩形/椭圆 | 无子节点的 RECTANGLE/ELLIPSE |
| 4 | **Loader** | 动态加载图片 | icon 子节点，需 `bar`/`grip` 子节点 |
| 5 | **Group** | 不可交互的分组容器 | Figma GROUP（纯装饰） |
| 6 | **Text** | 静态文本 | Figma TEXT |
| 7 | RichText | 富文本（含链接/换行） | 含 HTML 标签的文本 |
| 8 | InputText | 输入框 | 含「input」关键词的节点 |
| 9 | **Component** | 通用容器组件 | FRAME/INSTANCE 默认映射 |
| 10 | **List** | 列表（支持虚拟化） | 含 list/listview 关键词 |
| 11 | **Label** | 图标+文字复合组件 | 导航菜单项等 |
| 12 | **Button** | 按钮（三种模式，见下） | 含 button/btn/按钮 关键词 |
| 13 | **ComboBox** | 下拉选择框 | 含 combo/select/dropdown 关键词 |
| 14 | **ProgressBar** | 进度条 | 含 progress 关键词 |
| 15 | **Slider** | 滑动条 / Toggle 开关 | 含 slider/toggle/开关 关键词 |
| 16 | ScrollBar | 滚动条 | 自动生成，通常不手动映射 |
| 17 | Tree | 树形列表 | 含 tree 关键词 |

---

## 二、Button 的三种工作模式

FGUI Button 有三种模式，在 `semantic_tags.json` 中用 `button_mode` 字段指定：

### Common（普通按钮）— 默认
```json
{ "semantic_type": "Button", "button_mode": "Common" }
```
XML：`<Button/>`（不写 mode）  
特征：点击触发，不保持状态

### Check（复选按钮 / Toggle 开关）
```json
{ "semantic_type": "Button", "button_mode": "Check" }
```
XML：`<Button mode="Check"/>`  
特征：
- 可切换 selected/unselected 状态（开/关）
- **Figma 中 Toggle 开关 = Check 模式**
- 控制器页：0=normal, 1=down, 2=over, **3=selected**（选中/开启状态）
- 需要 `selectedOver` 控制器页支持 hover 时的选中态

**Toggle 开关的子节点命名规范：**
| 子节点 | FGUI 标准名 | 说明 |
|---|---|---|
| 轨道（圆角矩形背景） | `bar` | 绿色=开，灰色=关 |
| 滑块（圆形按钮） | `grip` | 白色圆形 |
| 文字（可选） | `title` | 显示 ON/OFF 文字 |

### Radio（单选按钮）
```json
{ "semantic_type": "Button", "button_mode": "Radio" }
```
XML：`<Button mode="Radio"/>`  
特征：
- 同一父容器内互斥，同时只有一个选中
- 用于 Tab 选项卡、单选组等
- 需要 Group 组件包裹以实现互斥逻辑

---

## 三、Figma 节点类型 → FGUI 组件映射

### 基础类型（固定映射）

| Figma type | FGUI ObjectType | 处理方式 |
|---|---|---|
| TEXT | Text | TextHandler |
| VECTOR / STAR / REGULAR_POLYGON / BOOLEAN_OPERATION | Image | 强制 SSR |
| RECTANGLE / ELLIPSE（无子节点） | Graph | GraphHandler |

### 容器类型（关键词优先，见 project-rules.json）

**判断顺序**：AI semanticType → project-rules.typeKeywords → rules/type-keywords.json → 默认 Component

| UI 形态 | FGUI 类型 | button_mode | 关键词示例 |
|---|---|---|---|
| 普通按钮 | Button | Common（默认） | button / btn / 按钮 |
| Toggle 开关 | Button | **Check** | toggle / switch / 开关 / Group_4613 |
| 单选按钮组 | Button | **Radio** | radio / 单选 |
| 进度条 | ProgressBar | — | progress / 进度 |
| 滑动条 | Slider | — | slider / range / 滑块 |
| 下拉框 | ComboBox | — | combo / select / dropdown |
| 列表 | List | — | list / listview / scroll |
| 图标+文字项 | Label | — | 导航菜单项 |
| 其他容器 | Component | — | 默认 |

> **关键提示**：`matchObjectType` 在匹配时**把空格和下划线视为等价**，
> 所以 `project-rules.json` 里写 `"Group_4613"` 可以匹配原始名 `"Group 4613"`。

---

## 四、子组件提取规则（SubComponentExtractor）

### 提取候选判断（"显著性"条件，OR 关系）

```
children.length > minChildrenToExtract
  OR  isExtensionType（Button / ProgressBar / Slider / ComboBox / Label / List）
  OR  hasNestedExtracted（含已提取的子组件）
  OR  hasVisuals && children.length > 0
```

### Toggle 开关的特殊处理

Toggle（`Group 4613`）= 含 Rectangle（轨道）+ Ellipse（滑块）的纯形状组  
→ `allDescendantsAreShapes` 判断为 true  
→ **但如果 semanticType = Slider，跳过整体 SSR，作为可交互组件提取**

这就是为什么必须在 `semantic_tags.json` 或 `project-rules.json` 中明确标注 Toggle 为 Slider/Button(Check)。

---

## 五、扩展组件标准命名（applyStandardNaming）

| 标准名称 | 适用父类型 | 节点类型 | 匹配关键词 |
|---|---|---|---|
| `title` | Button/Label/ProgressBar/Slider/ComboBox | Text | label/title/text/文本/数值 |
| `icon` | Button/Label | Image/Graph/Component | icon/img/图标（自动转 Loader） |
| `bar` | **ProgressBar/Slider/Button(Check)** | Image/Graph/Component | bar/progress/进度/轨道/track |
| `grip` | **Slider/Button(Check)** | Image/Graph/Component | grip/thumb/滑块/handle/knob |

> Toggle 开关的 `bar`（轨道矩形）和 `grip`（圆形滑块）命名对功能至关重要。

---

## 六、多状态控制器

### Button 控制器页（button 控制器）

| 页 | 状态 | 关键词 |
|---|---|---|
| 0 | up / normal（默认） | normal/up/default |
| 1 | down / pressed | down/pressed/clicked |
| 2 | over / hover | over/hover/focus |
| 3 | **selectedOver**（选中+悬停） | selected/checked/active |
| 4 | disabled | disabled/grayed |

> Check/Radio 模式的 Button，页3 = selectedOver 状态（选中态的悬停）  
> Toggle 开关：页0=关闭态，页3=开启选中态

### gearIcon 格式

```
{base}|{variant}|{base}|{selected}
```

含义：up | down | over | selectedOver（4个状态的图片资源）

---

## 七、图标 / 图集资源引用

- FGUI gearIcon URL 格式：`ui://{packageId}{resId}`（无斜杠分隔）
- 资源 ID 格式：`img_` + 语义名 + `_` + 短 NodeId
- 多状态图片：`{name}_{shortId}_page{N}.png`（N=状态页索引）
