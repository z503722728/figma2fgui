/**
 * analyze.ts — AnalyzeAgent CLI
 *
 * 职责：
 *   1. 解析 Figma URL
 *   2. 下载节点数据（或读取本地缓存）
 *   3. 生成节点摘要（depth≤5，含 thumbnailUrl）
 *   4. 写入 ai_input_prompt.md（供 IDE AI 读取）
 *   5. 打印 "等待 AI 分析" 提示，退出
 *
 * 之后由 IDE AI（主 Agent）读取 ai_input_prompt.md，
 * 生成 project-rules.json + semantic_tags.json，
 * 再调用 `bun run convert-only <url>` 完成转换。
 *
 * 用法：
 *   bun run analyze <figma_url>
 *   bun run analyze "https://www.figma.com/design/xxx/Name?node-id=1-1083"
 */
import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseFigmaUrl } from './utils/parseFigmaUrl';
import { FigmaClient } from './FigmaClient';
import { AISemanticTagger } from './tagger/AISemanticTagger';

async function analyze() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === '--help') {
        console.log(`
design2fgui analyze — 下载 Figma 数据并生成 AI 分析任务

用法：
  bun run analyze <figma_url>

示例：
  bun run analyze "https://www.figma.com/design/abc123/Name?node-id=1-1083"

输出：
  {output}/figma_debug.json      — Figma 数据缓存
  {output}/ai_input_summary.json — 节点摘要（depth≤5）
  {output}/ai_input_prompt.md    — IDE AI 分析任务（含截图 + 摘要 + 规范）

下一步：
  IDE AI 读取 ai_input_prompt.md → 生成 project-rules.json + semantic_tags.json
  → bun run convert-only <figma_url>
`);
        process.exit(0);
    }

    const figmaUrl   = args[0];
    const outputPath = args[1] ?? process.env.OUTPUT_PATH;

    // ─── 解析 URL ─────────────────────────────────────────────────────────────
    let fileKey: string;
    let nodeId: string | null | undefined;
    let fileName: string | null;

    try {
        const parsed = parseFigmaUrl(figmaUrl);
        fileKey  = parsed.fileKey;
        nodeId   = parsed.nodeId;
        fileName = parsed.fileName;
        console.log(`🔗 Figma URL 解析成功`);
        console.log(`   fileKey : ${fileKey}`);
        console.log(`   nodeId  : ${nodeId ?? '（整个文件）'}`);
    } catch (e: any) {
        console.error(`❌ URL 解析失败: ${e.message}`);
        process.exit(1);
    }

    const token = process.env.FIGMA_TOKEN;
    if (!token) {
        console.error('❌ 缺少 FIGMA_TOKEN，请在 .env 中配置');
        process.exit(1);
    }

    // ─── 路径 ─────────────────────────────────────────────────────────────────
    const defaultOutputDir = path.join(__dirname, '../FGUIProject/assets');
    const finalOutputDir   = outputPath || defaultOutputDir;
    const nodeIdForPath    = nodeId?.replace(/[:\-]/g, '_');
    const packName         = nodeIdForPath ? `Node_${nodeIdForPath}` : `File_${fileKey.slice(0, 8)}`;
    const packagePath      = path.join(finalOutputDir, packName);
    const debugJsonPath    = path.join(packagePath, 'figma_debug.json');

    await fs.ensureDir(packagePath);

    // ─── 获取 Figma 数据 ──────────────────────────────────────────────────────
    let figmaData: any;

    if (await fs.pathExists(debugJsonPath)) {
        console.log(`⚡ 使用本地缓存: ${debugJsonPath}`);
        figmaData = JSON.parse(await fs.readFile(debugJsonPath, 'utf-8'));
    } else {
        console.log(`📡 从 Figma API 获取数据...`);
        const client = new FigmaClient(token, fileKey);
        figmaData = nodeId
            ? await client.getNodes([nodeId])
            : await client.getFile();
        await fs.writeFile(debugJsonPath, JSON.stringify(figmaData, null, 2));
        console.log(`💾 数据已缓存: ${debugJsonPath}`);
    }

    // ─── 生成 AI 分析任务 ─────────────────────────────────────────────────────
    // 提取顶层节点
    const topNodes: any[] = [];
    if (figmaData.document) {
        figmaData.document.children.forEach((page: any) => {
            page.children.forEach((node: any) => {
                if (['FRAME', 'INSTANCE', 'COMPONENT'].includes(node.type)) {
                    topNodes.push(node);
                }
            });
        });
    } else if (figmaData.nodes) {
        Object.values(figmaData.nodes).forEach((nd: any) => {
            if (nd?.document) topNodes.push(nd.document);
        });
    }

    const tagger = new AISemanticTagger();
    // 传入 figmaData 以提取 thumbnailUrl
    const summaryPath = await tagger.dryRun(topNodes, packagePath, figmaData);

    // ─── 追加动态规则生成规范 到 prompt ──────────────────────────────────────
    const promptPath = path.join(packagePath, 'ai_input_prompt.md');
    const dynamicRulesSection = buildDynamicRulesSection(packagePath, figmaUrl);
    await fs.appendFile(promptPath, dynamicRulesSection, 'utf-8');

    // ─── 打印提示 ─────────────────────────────────────────────────────────────
    const thumbnailUrl = figmaData?.thumbnailUrl;
    console.log('');
    console.log('✅ 分析准备完成！请 IDE AI 执行以下步骤：');
    console.log('');
    console.log('  📄 阅读分析任务文件：');
    console.log(`     ${promptPath}`);
    if (thumbnailUrl) {
        console.log('');
        console.log('  🖼️  界面截图（先看图再看摘要）：');
        console.log(`     ${thumbnailUrl}`);
    }
    console.log('');
    console.log('  📝 生成两个文件（保存到同一目录）：');
    console.log(`     ${path.join(packagePath, 'project-rules.json')}`);
    console.log(`     ${path.join(packagePath, 'semantic_tags.json')}`);
    console.log('');
    console.log('  ▶️  分析完成后运行：');
    console.log(`     bun run convert-only "${figmaUrl}"`);
    console.log('');
}

/**
 * 生成追加到 ai_input_prompt.md 末尾的「动态规则生成」章节。
 * 告诉 IDE AI 如何生成 project-rules.json。
 */
function buildDynamicRulesSection(packagePath: string, figmaUrl: string): string {
    return `

---

## 你的任务：生成动态规则文件

分析完以上节点摘要后，生成以下两个文件：

### 文件 1：\`project-rules.json\`
保存路径：\`${path.join(packagePath, 'project-rules.json')}\`

根据此项目的节点命名习惯和 UI 结构，填写：

\`\`\`json
{
  "_generated_by": "IDE AI",
  "_figma_url": "${figmaUrl}",
  "_note": "动态规则：根据本项目节点树自动生成，覆盖 rules/ 下的静态默认规则",

  "typeKeywords": {
    "Button":      ["此项目中按钮的命名规律，如 btn, 按钮"],
    "Slider":      ["此项目中 Toggle/开关的命名规律，如 Group_4613"],
    "Label":       ["导航菜单项命名规律"],
    "ProgressBar": [],
    "List":        [],
    "ComboBox":    []
  },

  "backgroundNodeNames": [
    "此项目中作为背景原点的节点名称，如 bg, 背景色, Rectangle_1276"
  ],

  "excludeFromExtraction": [
    "纯装饰节点名称（不应提取为独立组件），如点阵分隔线"
  ],

  "componentGroups": [
    {
      "_note": "重复出现的相同结构组件，描述其状态差异",
      "namePattern": "节点名或命名规律",
      "semanticType": "Slider | Button | Component",
      "stateIndicator": "什么属性区分状态（fillColor / name关键词）",
      "states": {}
    }
  ],

  "coordZeroThreshold": 3.5,
  "scale": 2
}
\`\`\`

### 文件 2：\`semantic_tags.json\`
保存路径：\`${path.join(packagePath, 'semantic_tags.json')}\`

对每个有语义意义的节点标注类型和角色（格式见前文"输出格式"章节）。

**注意**：
- Toggle 开关 → \`"semantic_type": "Slider"\`，标注 \`bar\`（轨道）和 \`grip\`（圆形按钮）
- 含 Mask 的容器 → \`"semantic_type": "Component"\`，不是 \`"Image"\`
- 选中态导航项 = 普通态的 \`state_pages\`，不是独立组件
- 每个 \`fgui_name\` 用有意义的英文命名（如 \`Toggle_OnOff\`，不是 \`Group_4613\`）

---

完成后运行：
\`\`\`bash
bun run convert-only "${figmaUrl}"
\`\`\`
`;
}

analyze().catch(err => {
    console.error('💥 Error:', err.message ?? err);
    process.exit(1);
});
