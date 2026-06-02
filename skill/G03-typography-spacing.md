---
module_id: G03
owns: [字体映射, 文本对齐, 间距, 圆角, 全局缩放]
inputs_from: [G01]
outputs_to: [G05, G06]
version: "0.1.0"
---

# G03 — 字体 / 间距 / 圆角映射

---

## 一、全局缩放

所有数值型属性统一乘以 `scale`（默认 2，见 `rules/pipeline-config.json`）。

| 属性 | 乘以 scale |
|---|---|
| x / y 坐标 | ✅ |
| width / height | ✅ |
| fontSize | ✅ |
| borderRadius（corner） | ✅ |
| strokeSize（lineSize） | ✅ |
| letterSpacing | ✅ |
| lineHeight | ✅ |

---

## 二、文本属性映射

| Figma 属性 | FGUI XML 属性 | 备注 |
|---|---|---|
| `fontSize` | `fontSize` | × scale |
| `fontName.family` | `font` | 直接传递 |
| `fontName.style` 含 Bold | `bold="true"` | 字符串包含检测 |
| `fontName.style` 含 Italic | `italic="true"` | |
| `textAlignHorizontal` | `align` | 见对照表 |
| `textAlignVertical` | `vAlign` | 见对照表 |
| `letterSpacing` | `letterSpacing` | × scale |
| `lineHeight.value` | `lineSpacing` | 仅 FIXED 类型；× scale |
| `fills[0].color` | `color` | 文本颜色 |

### 水平对齐对照

| Figma | FGUI |
|---|---|
| LEFT | left（默认，可省略） |
| CENTER | center |
| RIGHT | right |
| JUSTIFIED | left（FGUI 不支持两端对齐，降级） |

### 垂直对齐对照

| Figma | FGUI |
|---|---|
| TOP | top（默认） |
| CENTER | middle |
| BOTTOM | bottom |

---

## 三、圆角

- Figma `cornerRadius`（统一圆角）→ FGUI `corner` × scale
- Figma `rectangleCornerRadii`（四角独立）→ FGUI `corner` 取平均值 × scale  
  > 注：FGUI Graph 组件仅支持统一圆角，四角独立圆角节点建议整体 SSR。

---

## 四、间距（Padding）

Figma Frame 的 `paddingTop/Right/Bottom/Left` 目前未直接映射到 FGUI（FGUI 不支持 CSS padding 概念）。

**当前处理策略**：将 padding 计入子节点的相对坐标偏移，无需输出额外 XML 属性。

> 如项目需要精确 padding 支持，可在此模块添加规则后仲裁。
