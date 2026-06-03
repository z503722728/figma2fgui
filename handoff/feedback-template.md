# 标注修订反馈模板

将此文件复制到对应的 `packagePath` 目录（如 `FGUIProject/assets/Node_1_950/`），
文件名改为 `feedback.md`，填写后运行：

```bash
bun run analyze --revise
```

---

## 使用说明

- 每条反馈对应一个问题，格式：**节点ID / 节点名 → 问题描述 → 期望结果**
- 支持多条反馈，AI 会逐一修正后输出完整的 `semantic_tags.json`
- `feedback.md` 消费后会自动归档（`feedback_时间戳.md.bak`），不会重复触发

---

## 反馈内容（填写后删除此行）

### 问题 1
- **节点**：`1:983` / `list_GachaItems`
- **当前标注**：`semantic_type: List`，`list_col_gap: 80`
- **问题**：间距太大，实际每列间隔只有 20px
- **期望**：`list_col_gap: 40`

### 问题 2
- **节点**：`1:1055` / `bar_Buttons`
- **当前标注**：`reparent` 到 `1:952`
- **问题**：reparent 后位置偏移，按钮出现在弹窗外
- **期望**：移除 `reparent`，保持原始层级，在 `risks` 里说明

### 问题 3（自由描述）
- 导航栏 `Nav_Menu` 里的点阵分隔线（`Frame_7/8/9/10`）被当成了独立组件提取，
  应该整体 SSR，在 `excludeFromExtraction` 或 `children_roles` 里处理掉

---

## 备注
<!-- 可在此记录其他上下文，AI 会参考 -->
