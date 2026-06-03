---
module_id: G05
owns: [FGUI 组件类型映射, 子组件提取规则, 扩展组件标准命名, 多状态控制器, Button 模式, List 内联, variant_layers, reparent]
inputs_from: [G01, G02, G03, G04]
outputs_to: [G06]
version: "1.2.0"
---

# G05 — 组件映射 / 子组件提取 / 多状态

---

## 一、FGUI 完整组件类型（ObjectType）

| ID | 名称 | 说明 | 转换来源 |
|---|---|---|---|
| 0 | **Image** | 静态图片 | VECTOR/STAR/矢量形状，整体 SSR |
| 1 | MovieClip | 序列帧动画 | `.jta` 资源 |
| 3 | **Graph** | 纯色/渐变矩形/椭圆 | 无子节点的 RECTANGLE/ELLIPSE |
| 4 | **Loader** | 动态加载图片 | icon 子节点，gearIcon 换图时自动升级为 Loader |
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
- 控制器名：`button`，4页：0=up, 1=down, 2=over, 3=selectedOver

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
特征：同一父容器内互斥，用于 Tab 选项卡

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
| Toggle 开关 | Button | **Check** | toggle / switch / 开关 |
| 单选按钮组 | Button | **Radio** | radio / 单选 |
| 进度条 | ProgressBar | — | progress / 进度 |
| 滑动条 | Slider | — | slider / range / 滑块 |
| 下拉框 | ComboBox | — | combo / select / dropdown |
| 列表 | List | — | list / listview / scroll |
| 图标+文字项 | Label | — | 导航菜单项 |
| 其他容器 | Component | — | 默认 |

---

## 四、List 组件生成规则

**List 节点直接内联到父组件的 displayList**，不生成中间 `list_xxx.xml` 文件。

```xml
<list id="n9" name="list_Items" xy="..." size="..."
      layout="FlowH" overflow="scroll"
      autoClearItems="true"
      defaultItem="ui://{buildId}{itemResId}"/>
```

- `autoClearItems="true"`：编辑器预览时清除预置 item，发布后正常
- `defaultItem`：来自 `list_item_template`（名称）或 `list_item_node_id`（精确节点 ID）
- **List 子节点是 item template，不展开到 displayList**

### List item template 标注

```json
{
  "node_id": "1:983",
  "semantic_type": "List",
  "fgui_name": "list_GachaItems",
  "list_item_template": "GachaItem",
  "list_item_node_id": "1:985"
}
```

- `list_item_template`：template 组件名称（在 _newResources 里按名称查找）
- `list_item_node_id`：精确节点 ID（当 template 不是 list 直接子节点时使用）

---

## 五、多变体图层（variant_layers）

当 List item 或普通组件有多种颜色/外观变体（结构相同、颜色不同）时，用 `variant_layers` 描述：

```json
{
  "node_id": "1:985",
  "semantic_type": "Component",
  "fgui_name": "GachaItem",
  "variant_layers": {
    "controller": "state",
    "role": "bg",
    "pages": [
      { "index": 0, "name": "blue",   "node_id": "1:985" },
      { "index": 1, "name": "green",  "node_id": "1:991" },
      { "index": 2, "name": "yellow", "node_id": "1:997" },
      { "index": 3, "name": "purple", "node_id": "1:1003" },
      { "index": 4, "name": "orange", "node_id": "1:1009" }
    ]
  }
}
```

生成效果：
```xml
<component size="288,288">
  <controller name="state" pages="0,blue,1,green,2,yellow,3,purple,4,orange"/>
  <displayList>
    <loader name="bg" ...>
      <gearIcon controller="state" pages="0,1,2,3,4"
        values="ui://...img_1_985|ui://...img_1_991|..."/>
    </loader>
    <image name="item_icon" .../>
  </displayList>
</component>
```

**使用场景**：
- List item 有 N 种颜色变体（各变体尺寸相同）
- 游戏代码通过设置 `state` controller 的页码切换颜色
- 各变体图片由 Figma 各自的节点 SSR 下载

---

## 六、节点层级调整（reparent）

当 Figma 中节点层级放错（如弹窗按钮栏与弹窗同级），AI 可输出 `reparent` 指令调整层级：

```json
{
  "node_id": "1:1055",
  "reparent": {
    "new_parent": "1:952",
    "role": "bar_buttons"
  }
}
```

**触发条件**（同时满足）：
1. 节点的 `absoluteBoundingBox` 完全在目标父节点范围内
2. 名称/语义上有明确的归属关系（如"按钮栏"属于"弹窗"）
3. Figma 层级是平级但设计上是父子关系

**效果**：
- 节点从原位置移除，插入新父节点
- 坐标自动转换（基于 `absoluteBoundingBox` 差值）
- 新父节点的 `children_roles` 自动更新

**注意**：不确定时**不要** reparent，保持原始层级，在 `risks` 中说明。

---

## 七、子组件提取规则（SubComponentExtractor）

### 提取候选判断（"显著性"条件，OR 关系）

```
children.length > minChildrenToExtract
  OR  isExtensionType（Button / ProgressBar / Slider / ComboBox / Label / List）
  OR  hasNestedExtracted（含已提取的子组件）
  OR  hasVisuals && children.length > 0
```

### 有 AI 语义标注的节点

- 有 `semanticType` 的节点**不跳过纯形状检查**
- 例：`GachaItem`（全是 RECTANGLE）有 `semantic_type: Component` → 不整体 SSR，正常提取
- 有 `variant_layers` 的节点不走 `_mergeWithParent` 整体 SSR 路径

### 同结构节点去重（哈希合并）

- 结构相同的多个实例 → 合并为一个组件文件
- **有 AI `fgui_name` 标注的节点**：哈希加入节点名称，防止同结构不同语义的组件被错误合并
  - 例：`Btn_ArrowLeft` 和 `Btn_ArrowRight` 结构相同但语义不同 → 各自独立生成

---

## 八、扩展组件标准命名（applyStandardNaming）

| 标准名称 | 适用父类型 | 节点类型 | 匹配关键词 |
|---|---|---|---|
| `title` | Button/Label/ProgressBar/Slider/ComboBox | Text | label/title/text/文本/数值 |
| `icon` | Button/Label | Image/Graph/Component | icon/img/图标（自动转 Loader） |
| `bar` | **ProgressBar/Slider/Button(Check)** | Image/Graph/Component | bar/progress/进度/轨道/track |
| `grip` | **Slider/Button(Check)** | Image/Graph/Component | grip/thumb/滑块/handle/knob |

AI 通过 `children_roles` 优先赋予角色名：
```json
"children_roles": {
  "1:1057": "bg",
  "1:1058": "bg_mask",
  "1:1068": "title"
}
```

---

## 九、多状态控制器

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

### gearIcon 格式（button controller）

```
{off}|{on}|{off}|{on}
```

含义：up(off) | down(on) | over(off) | selectedOver(on)

### gearIcon 格式（state controller，variant_layers）

```
{page0_img}|{page1_img}|{page2_img}|...
```

含义：各状态页对应的图片资源（个数与 pages 数量一致）

---

## 十、图标 / 图集资源引用

- FGUI gearIcon URL 格式：`ui://{packageId}{resId}`（无斜杠分隔）
- 资源 ID 格式：`img_` + 语义名 + `_` + 短 NodeId
- 多状态图片：`{name}_{shortId}_page{N}.png`（N=状态页索引）
- **旋转约180°的图片**：自动转换为 `flip="horizontal"`，避免位置偏移
