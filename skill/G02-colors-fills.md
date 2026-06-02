---
module_id: G02
owns: [颜色属性映射, 填充类型, 描边, 渐变, 主题色处理]
inputs_from: [G01]
outputs_to: [G05, G06]
version: "0.1.0"
---

# G02 — 颜色与填充属性映射

---

## 一、Figma fills → FGUI 填充类型

| Figma fill.type | UINode.styles.fillType | FGUI 处理方式 |
|---|---|---|
| `SOLID` | `color` | PropertyMapper 输出 `color` XML 属性 |
| `GRADIENT_LINEAR` / `GRADIENT_RADIAL` | `gradient` | 整个节点作为视觉叶，强制 SSR 渲染为 PNG |
| `IMAGE` | `image` | 整个节点作为视觉叶，强制 SSR 渲染为 PNG |
| `PATTERN` | `image` | 同上 |
| 无填充 | 不设置 | PropertyMapper 跳过颜色属性 |

> **规则**：凡是 `gradient` 或 `image` 填充，父容器节点强制插入 `_bg` 虚拟图片节点。

---

## 二、颜色值格式

FGUI XML 中颜色格式为 `#RRGGBB` 或命名颜色（`black`/`white` 等）。

命名颜色字典（来自 `PropertyMapper.ts` 的 `NAMED_COLORS`，可扩展到 `rules/` 中）：

```
black / white / red / green / blue / gray / yellow / cyan / magenta
silver / maroon / olive / lime / purple / teal / navy / orange / transparent
```

> **建议**：将命名颜色字典迁移到 `rules/named-colors.json`，支持项目自定义颜色别名。

---

## 三、描边（stroke）

| Figma 属性 | UINode 属性 | FGUI XML 属性 |
|---|---|---|
| `strokes[0].color` | `styles.strokeColor` | `lineColor` |
| `individualStrokeWeights` / `strokeWeight` | `styles.strokeSize` | `lineSize`（× scale） |
| `strokeAlign` | — | FGUI 不支持外/内描边区分，统一居中 |

---

## 四、透明度

- Figma `opacity` → FGUI XML `alpha`（范围 0–1，乘以 255 转为 0–255 整数）
- 子节点 `opacity` 不向上合并，各自独立输出

---

## 五、视觉叶节点判定（决定是否 SSR）

以下任一条件满足，节点被标记为视觉叶（整体 SSR 渲染为 PNG，不再展开子节点）：

1. `ObjectType.Image` → 直接 SSR
2. 容器有 `fillColor`/`strokeColor`/`imageFill` 且无文本子节点
3. 所有后代全为 `Image`/`Graph`（纯形状组）
4. 含 `isMask` 后代且非 `asComponent`

> 此规则实现在 `ImagePipeline.isVisualLeaf()`，判断逻辑对应 `G02` 仲裁范围。
