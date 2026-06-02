---
module_id: G04
owns: [FGUI 坐标系, 层级结构, displayList 展平, 坐标规范化]
inputs_from: [G01, G02, G03]
outputs_to: [G05, G06]
version: "0.1.0"
---

# G04 — 布局 / 层级 / 坐标系

---

## 一、FGUI 坐标系规则

FGUI 是**扁平 displayList**，没有嵌套容器概念。所有子节点坐标相对于组件根节点左上角。

### ContainerHandler 展平逻辑

```
容器节点 → 遍历子节点：
  子节点坐标 += 父节点偏移 (x,y)
  → 递归展平到同级 displayList
```

展平时合并条件（满足其一跳过展平，直接作为原子节点输出）：
- 节点有 `src`（已是 SSR 图片）
- 节点有视觉属性（`fillColor`/`strokeColor`）→ 先输出一个 `graph` 元素

---

## 二、坐标来源优先级

```
1. node.relativeTransform（Figma 精确本地坐标）         ← 优先
2. absoluteBoundingBox.x - parentAbsX                   ← 降级
3. 坐标绝对值 < coordZeroThreshold.px → 归零           ← 浮点修正
```

> `coordZeroThreshold.px` 值见 `rules/exclude-names.json`，默认 3.5。

---

## 三、组件坐标规范化（justifyComponentLayout）

FGUI 组件坐标系以背景节点左上角为原点。规范化步骤：

**Phase 1**：识别背景节点  
- 名称关键词匹配 `rules/exclude-names.json → backgroundDetection.keywords`  
- 多个候选时取面积最大的

**Phase 2**：偏移规范化  
```
offsetX = -bgNode.x
offsetY = -bgNode.y
所有子节点 x += offsetX；y += offsetY
组件 width/height = bgNode.width/height
```

**Phase 3**：越界检查  
- 子节点完全在组件边界外 → `console.warn` 警告，不自动移除

**Fallback**（无背景节点）：  
- 将负坐标子节点整体向正方向平移
- 扩展组件尺寸以容纳所有子节点

---

## 四、Button 子节点 Z-order

Button 内部子节点强制按三层排序（从底到顶）：

| 优先级 | 条件 | 说明 |
|---|---|---|
| 0（最底） | 名称含 bg/background | 背景层 |
| 1（中间） | 有 src 的图像节点 | 图片/图标层 |
| 2（最顶） | 其他（文本等） | 内容层 |

---

## 五、旋转

- Figma `relativeTransform` 矩阵 → `rotation = atan2(c, a) * (180/π)`
- FGUI XML `rotation` 属性直接接收角度值
- 旋转节点的 width/height 使用 Figma `absoluteBoundingBox`（旋转后包围盒）
