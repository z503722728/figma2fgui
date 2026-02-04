# Figma2FGUI - 全自动云端转换引擎

Figma2FGUI 是一个高性能的自动化工具，旨在将 Figma 云端设计稿直接转换为 FairyGUI (FGUI) 工程包。

## 🚀 核心特性
- **云端全自动**：直接通过 Figma REST API 抓取数据，无需手动导出。
- **高清资源渲染**：自动识别图片节点并请求 2x 高清渲染并下载。
- **智能组件提取**：识别 `INSTANCE` 节点并自动生成独立子组件。
- **深度去重**：基于结构哈希识别重复组件，极大精简项目体积。
- **布局还原**：集成 Yoga Flexbox 引擎，完美还原 Figma 的 Auto Layout。

## 🛠️ 快速开始

### 1. 配置环境
在项目根目录新建 `.env` 文件（已在 `.gitignore` 中忽略，安全可靠）：
```env
FIGMA_TOKEN=您的_Figma_Personal_Access_Token
FIGMA_FILE_KEY=您的_设计稿_File_Key
FIGMA_NODE_ID=可选_特定节点ID_如_3:1477
OUTPUT_PATH=可选_自定义输出根路径
```

### 2. 获取凭据说明
- **FIGMA_FILE_KEY**: URL 中 `/design/` 后面的那一串。
- **FIGMA_NODE_ID**: 选中某个 Frame 时，URL 参数中 `node-id=xxx` 的值（注意：冒号需保留，如 `3:1477`，在终端或 .env 中使用时确保格式正确）。
- **OUTPUT_PATH**: 默认为项目下的 `output/FigmaProject`。

### 2. 安装依赖
```bash
cd figma2fgui
bun install
```

### 3. 运行转换
```bash
bun start
```

## 📁 目录结构
- `src/`: 核心源代码（解析器、生成器、Flex 计算器）。
- `output/`: 转换生成的 FGUI 包。
- `input/`: 本地 JSON 测试数据目录。

## ⚙️ 进阶配置
如果需要转换特定节点，可以在 `index.ts` 中调整 `node-id` 过滤逻辑。

---
*由管家小智 (🌌) 维护*
