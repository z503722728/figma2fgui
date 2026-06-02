/**
 * CLI 入口：接收 Figma 分享链接，自动解析 fileKey / nodeId，驱动完整转换管线。
 *
 * 用法：
 *   bun run src/cli.ts <figma_url> [output_path]
 *
 * 示例：
 *   bun run src/cli.ts "https://www.figma.com/design/MkXcjtn8mj33vXj0eoOr7u/xxx?node-id=1-1083"
 *   bun run src/cli.ts "https://www.figma.com/design/MkXcjtn8mj33vXj0eoOr7u/xxx?node-id=1-1083" ./output
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { parseFigmaUrl } from './utils/parseFigmaUrl';
import { run } from './index';

async function cli() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        printHelp();
        process.exit(0);
    }

    const figmaUrl  = args[0];
    const outputPath = args[1] ?? process.env.OUTPUT_PATH;

    // ─── 解析 Figma URL ────────────────────────────────────────────────────────
    let fileKey = '';
    let nodeId: string | null | undefined;

    try {
        const parsed = parseFigmaUrl(figmaUrl);
        fileKey = parsed.fileKey;
        nodeId  = parsed.nodeId;

        console.log('🔗 解析 Figma URL 成功：');
        console.log(`   fileKey : ${fileKey}`);
        console.log(`   nodeId  : ${nodeId ?? '（未指定，将转换整个文件）'}`);
        if (parsed.fileName) console.log(`   文件名  : ${parsed.fileName}`);
        console.log('');
    } catch (e: any) {
        console.error(`❌ URL 解析失败：${e.message}`);
        console.error('');
        console.error('请检查 URL 格式，示例：');
        console.error('  https://www.figma.com/design/{fileKey}/{name}?node-id={nodeId}');
        process.exit(1);
    }

    // ─── 检查 Token ───────────────────────────────────────────────────────────
    const token = process.env.FIGMA_TOKEN;
    if (!token) {
        console.error('❌ 缺少 FIGMA_TOKEN，请在 .env 中配置：');
        console.error('   FIGMA_TOKEN=figd_your_personal_access_token');
        process.exit(1);
    }

    // ─── 运行转换 ─────────────────────────────────────────────────────────────
    await run({
        figmaToken:   token,
        figmaFileKey: fileKey,
        figmaNodeId:  nodeId ?? undefined,
        outputPath,
    });
}

function printHelp() {
    console.log(`
design2fgui — Figma → FairyGUI 转换工具

用法：
  bun run src/cli.ts <figma_url> [output_path]

参数：
  figma_url    Figma 设计稿分享链接（必填）
  output_path  FGUI 包输出目录（可选，默认读 .env OUTPUT_PATH）

示例：
  # 转换指定节点
  bun run src/cli.ts "https://www.figma.com/design/abc123/MyUI?node-id=1-1083"

  # 指定输出目录
  bun run src/cli.ts "https://www.figma.com/design/abc123/MyUI?node-id=1-1083" ./FGUIProject/assets

  # 使用 AI 语义标注（需在 .env 配置 AI_API_KEY）
  AI_API_KEY=sk-xxx bun run src/cli.ts "https://..."

  # Dry-run：只生成摘要文件，不调用 AI API
  AI_DRY_RUN=true bun run src/cli.ts "https://..."

环境变量（在 .env 中配置）：
  FIGMA_TOKEN       必填，Figma Personal Access Token
  OUTPUT_PATH       默认输出目录
  AI_API_KEY        可选，AI 语义标注接口密钥
  AI_MODEL          可选，默认 gpt-4o-mini
  AI_DRY_RUN        可选，设为 true 时只生成摘要文件
  FORCE_DOWNLOAD    可选，设为 true 时强制重新下载所有图片
`);
}

cli().catch(err => {
    console.error('💥 Critical Error:', err.message ?? err);
    process.exit(1);
});
