# Figma2FGUI — Figma → FairyGUI 全自动转换引擎

将 Figma 云端设计稿直接转换为 FairyGUI (FGUI) 工程包，零手动操作。

## 🚀 核心特性

- **云端全自动** — 通过 Figma REST API 直接抓取设计数据，无需手动导出
- **SSR 高清渲染** — 自动识别视觉叶节点，请求 Figma 2x 服务端渲染 (PNG)
- **智能组件提取** — 自动识别重复 INSTANCE 结构，提取为独立 FGUI 子组件
- **多状态按钮** — 自动检测视觉变体（如不同颜色的按钮），生成 `gearIcon` 控制器切换
- **布局还原** — 集成 Yoga Flexbox 引擎，还原 Figma Auto Layout
- **全局 2x 缩放** — 坐标、尺寸、字号、圆角、描边统一 2x 输出，匹配高清资源
- **智能缓存** — 缓存 Figma 数据 (`figma_debug.json`) 和图片资源，重跑秒级完成

## 📐 架构概览

```
src/
├── index.ts                    # 主入口：编排整条管线
├── RawFigmaParser.ts           # Figma REST API → UINode 树
├── FigmaClient.ts              # Figma API 客户端
├── ImagePipeline.ts            # SSR 渲染：扫描视觉叶 → 批量获取 URL → 并发下载
├── FlexLayoutCalculator.ts     # Yoga Flexbox 布局计算
├── Common.ts                   # 公共工具函数
├── models/
│   ├── UINode.ts               # 核心数据结构
│   └── FGUIEnum.ts             # FGUI 枚举定义
├── mapper/
│   └── PropertyMapper.ts       # UINode 属性 → FGUI XML 属性映射 (含 2x 缩放)
└── generator/
    ├── XMLGenerator.ts         # 组件 XML / package.xml 生成
    ├── SubComponentExtractor.ts # 子组件提取 + 多状态分析 + 命名标准化
    └── handlers/               # 按节点类型分发的 XML 生成处理器
        ├── HandlerRegistry.ts  #   类型 → Handler 注册表
        ├── ContainerHandler.ts #   容器节点 (Component/Group/Button...)
        ├── ImageHandler.ts     #   图片节点
        ├── LoaderHandler.ts    #   Loader 节点 (多状态切换)
        ├── TextHandler.ts      #   文本节点
        ├── GraphHandler.ts     #   图形节点 (rect/ellipse)
        ├── ComponentRefHandler.ts # 子组件引用
        ├── ListHandler.ts      #   列表节点
        └── INodeHandler.ts     #   Handler 接口定义
```

### 数据流

```
Figma API ──► RawFigmaParser ──► UINode 树
                                    │
                    SubComponentExtractor
                    ├── 收集候选组件 (重复结构检测)
                    ├── 分析视觉变体 (fingerprint 分组 → multiLooks)
                    ├── 树变换 (组件引用替换)
                    └── 状态检测 (按钮 controller/gear)
                                    │
                    ImagePipeline
                    ├── scanAndEnqueue (识别视觉叶节点)
                    ├── 批量获取 Figma SSR URL
                    └── 并发下载 PNG (带缓存)
                                    │
                    XMLGenerator + Handlers
                    ├── 生成组件 XML (displayList)
                    └── 生成 package.xml (资源清单)
```

## 🎬 测试文件

你可以使用以下 Figma 设计稿作为测试基准，验证转换引擎的不同特性：

| 设计稿名称 | 链接 | 核心测试点 |
| :--- | :--- | :--- |
| **GAME UI Design** | [Figma 社区](https://www.figma.com/community/file/1050752368690341429) | 按钮变体、复杂嵌套组件、Auto Layout |
| **Figma Unity Bridge Example** | [Figma 社区](https://www.figma.com/community/file/1230440663355118588) | 基础图形、Loader 切换、文本样式映射 |

## 🛠️ 快速开始

### 1. 配置环境

在项目根目录新建 `.env` 文件：

```env
FIGMA_TOKEN=你的_Figma_Personal_Access_Token
FIGMA_FILE_KEY=设计稿_File_Key
FIGMA_NODE_ID=可选_特定节点ID_如_3:1679
OUTPUT_PATH=可选_输出路径_默认为项目下_FGUIProject/assets/
```

### 2. 获取凭据

- **FIGMA_FILE_KEY**: 设计稿 URL 中 `/design/` 后面的字符串
- **FIGMA_NODE_ID**: 选中 Frame 时 URL 参数中 `node-id=xxx` 的值（保留冒号，如 `3:1679`）
- **FIGMA_TOKEN**: Figma → Settings → Personal Access Tokens

### 3. 安装 & 运行

```bash
bun install
bun start
```

### 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `FIGMA_TOKEN` | ✅ | Figma API 访问令牌 |
| `FIGMA_FILE_KEY` | ✅ | 设计稿文件 Key |
| `FIGMA_NODE_ID` | 可选 | 指定节点 ID，不填则转换整个文件 |
| `OUTPUT_PATH` | 可选 | 输出根路径 |
| `FORCE_DOWNLOAD` | 可选 | 设为 `true` 强制重新下载所有图片 |

## 🔑 关键设计决策

### 视觉叶节点检测 (`isVisualLeaf`)

ImagePipeline 通过以下规则判定节点是否应作为整体渲染为一张 PNG：

1. **Image 类型** (RECTANGLE/VECTOR/ELLIPSE...) → 直接渲染
2. **容器类型** 且所有后代均为形状节点 → 合并渲染为一张图
3. **asComponent 节点** 永远不作为视觉叶 → 递归扫描子节点

### 多状态按钮 (`multiLooks` + `gearIcon`)

- 通过 `computeVisualFingerprint` 对比同一组件的所有实例外观
- 不同外观（如红色/黄色背景）自动生成独立 SSR 图片资源
- 使用 FGUI `loader` + `gearIcon` 实现按钮状态切换
- Button 控制器：变体统一映射到 `down` (页 1)，其余页使用基础图标

### 全局 2x 缩放 (`FGUI_SCALE`)

`PropertyMapper` 中定义 `FGUI_SCALE = 2`，统一应用于：
- 组件根尺寸、坐标、字号、圆角、描边宽度
- ImagePipeline 资源尺寸
- `injectBackground` 背景尺寸

## ⚠️ 注意事项

- **🚨 禁止在 FGUI 编辑器中点击「刷新」按钮** — 会重置 `package.xml` 的资源 ID，破坏所有引用。正确做法：关闭项目 → 重新打开。
- **缓存机制** — 首次运行后，Figma 数据缓存为 `figma_debug.json`，图片缓存到 `img/` 目录。设置 `FORCE_DOWNLOAD=true` 或删除 `.manifest.json` 可强制刷新。
- **Figma 设计规范** — 同一组件的实例应保持一致的样式属性（如描边色），否则会产生冗余的变体资源。
