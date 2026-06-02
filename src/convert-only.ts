/**
 * convert-only.ts — ConvertAgent CLI
 *
 * 职责：
 *   读取 AI 已生成的 project-rules.json + semantic_tags.json，
 *   执行 Figma → FGUI 转换，输出 XML 包。
 *
 * 前置条件：已运行 `bun run analyze <url>` 并由 IDE AI 完成分析。
 *
 * 用法：
 *   bun run convert-only <figma_url> [output_path]
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { parseFigmaUrl } from './utils/parseFigmaUrl';
import { run } from './index';

async function convertOnly() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === '--help') {
        console.log(`
design2fgui convert-only — 执行转换（需先运行 analyze）

用法：
  bun run convert-only <figma_url> [output_path]

前置条件：
  已运行 bun run analyze <figma_url>
  IDE AI 已生成 project-rules.json + semantic_tags.json

示例：
  bun run convert-only "https://www.figma.com/design/abc123/Name?node-id=1-1083"
`);
        process.exit(0);
    }

    const figmaUrl   = args[0];
    const outputPath = args[1] ?? process.env.OUTPUT_PATH;

    let fileKey: string = '';
    let nodeId: string | null | undefined;

    try {
        const parsed = parseFigmaUrl(figmaUrl);
        fileKey = parsed.fileKey;
        nodeId  = parsed.nodeId;
        console.log(`🔗 Figma URL: fileKey=${fileKey}, nodeId=${nodeId ?? '全文件'}`);
    } catch (e: any) {
        console.error(`❌ URL 解析失败: ${e.message}`);
        process.exit(1);
    }

    const token = process.env.FIGMA_TOKEN;
    if (!token) {
        console.error('❌ 缺少 FIGMA_TOKEN，请在 .env 中配置');
        process.exit(1);
    }

    await run({
        figmaToken:   token,
        figmaFileKey: fileKey,
        figmaNodeId:  nodeId ?? undefined,
        outputPath,
    });
}

convertOnly().catch(err => {
    console.error('💥 Error:', err.message ?? err);
    process.exit(1);
});
