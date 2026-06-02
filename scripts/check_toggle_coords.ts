import * as fs from 'fs-extra';
import * as dotenv from 'dotenv';
dotenv.config();

const d = await fs.readJson('./FGUIProject/assets/Node_1_1083/figma_debug.json');

function find(n: any, id: string): any {
    if (n.id === id) return n;
    if (n.children) for (const c of n.children) { const r = find(c, id); if (r) return r; }
    return null;
}

const nodes = Object.values(d.nodes || {}) as any[];
const root = (nodes[0] as any)?.document;

// on状态 Toggle: 1:1186，off状态: 1:1195
for (const [label, id] of [['ON(1:1186)', '1:1186'], ['OFF(1:1195)', '1:1195']]) {
    const t = find(root, id);
    if (!t) continue;
    const tb = t.absoluteBoundingBox;
    console.log(`\n${label} Toggle: xy=(${tb?.x},${tb?.y}) size=${tb?.width}x${tb?.height}`);
    for (const c of t.children || []) {
        const b = c.absoluteBoundingBox;
        // 坐标相对 Toggle 父节点
        const rx = b?.x - tb?.x;
        const ry = b?.y - tb?.y;
        console.log(`  child "${c.name}" [${c.id}]: relXY=(${rx?.toFixed(1)},${ry?.toFixed(1)}) size=${b?.width?.toFixed(1)}x${b?.height?.toFixed(1)}`);
        for (const cc of c.children || []) {
            const bb = cc.absoluteBoundingBox;
            const rrx = bb?.x - tb?.x;
            const rry = bb?.y - tb?.y;
            console.log(`    sub "${cc.name}": relXY=(${rrx?.toFixed(1)},${rry?.toFixed(1)}) size=${bb?.width?.toFixed(1)}x${bb?.height?.toFixed(1)}`);
        }
    }
}
