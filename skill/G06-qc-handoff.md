---
module_id: G06
owns: [验收 checklist, 冲突仲裁, 回收 YAML 聚合, 风险输出]
inputs_from: [G01, G02, G03, G04, G05]
outputs_to: []
version: "0.1.0"
---

# G06 — 验收 / 冲突仲裁 / 交付

---

## 一、转换验收 Checklist

每次转换完成后，逐项确认：

### 结构层
- [ ] 所有 FRAME/INSTANCE/COMPONENT 节点已完成类型判断（有 `semanticType` 或命中 type-keywords）
- [ ] 提取的子组件均有对应 `.xml` 文件
- [ ] `package.xml` 中所有组件 ID 唯一，无重复

### 属性层
- [ ] 所有文字节点已映射到 FGUI Text 组件（非裸字符串）
- [ ] 扩展组件（Button/ProgressBar/Slider）子节点名称符合 G05 标准命名
- [ ] 所有尺寸/坐标已乘以 scale，无原始 px 值残留
- [ ] 圆角值已 × scale

### 资源层
- [ ] 所有 SSR 图片已下载到 `img/` 目录
- [ ] `package.xml` 图片路径为相对路径（`img/xxx.png`），无绝对路径
- [ ] 多状态图片命名含 `_page{N}` 后缀

### 风险层
- [ ] 检查 AI 标注回收 YAML 中的 `risks` 字段，逐项人工确认
- [ ] 检查 console 中的 `⚠️` 警告（越界节点、命名不规范、AI 降级等）

---

## 二、冲突仲裁原则

| 优先级 | 原则 | 说明 |
|---|---|---|
| 1 | **AI 语义优先** | AI 标注的 `semanticType` 覆盖关键词匹配结果 |
| 2 | **规则文件优先** | `rules/*.json` 中的显式配置覆盖代码默认值 |
| 3 | **Figma 数据优先** | `relativeTransform` 坐标优先于 `absoluteBoundingBox` 计算值 |
| 4 | **背景节点优先** | 含背景节点时使用背景节点坐标原点，否则用 Fallback 规范化 |
| 5 | **保守输出** | 无法确定时输出 `Component` 类型 + 写入 risks，不猜测 |

---

## 三、回收 YAML 模板

每次转换任务完成后填写并保存（可用于审计和问题复现）：

```yaml
task_id:              # 转换任务唯一标识（如 Figma NodeId）
timestamp:            # 执行时间
figma_version:        # Figma 文件版本号

inputs_used:
  - Figma file key: xxx
  - Node ID: xxx
  - AI model: xxx（如未使用填 none）

component_decisions:  # 关键组件类型判断
  - "node[xxx] '按钮组件' → Button（AI标注）"
  - "node[yyy] 'icon_home' → Image（关键词匹配）"

naming_decisions:     # 子节点重命名
  - "node[zzz] '文本1' → title（naming-map匹配）"

artifacts:            # 生成产物
  - package.xml
  - Button_xxx.xml
  - img/xxx.png

risks:                # 需人工干预
  - "node[aaa] 无法识别类型，已降级为 Component"
  - "node[bbb] 超出组件边界，请检查坐标"

next_step: "在 FairyGUI 编辑器中导入并检查扩展组件功能"
```

---

## 四、常见问题快速仲裁

| 现象 | 根因 | 解决方式 |
|---|---|---|
| Button 无法点击 | `title`/`icon` 子节点未正确命名 | 检查 G05 标准命名，更新 `rules/naming-map.json` |
| 组件偏移错误 | 背景节点未被识别 | 检查 `rules/exclude-names.json → backgroundDetection.keywords` |
| 图片空白 | SSR 下载失败或 nodeId 映射错误 | 检查 `img/` 目录，设置 `FORCE_DOWNLOAD=true` 重试 |
| 类型误判 | 节点命名不规范 | 更新 `rules/type-keywords.json` 的关键词列表 |
| AI 标注不准确 | System Prompt 缺少项目特定规则 | 在 `skill/G05-components.md` 中补充项目约定 |
