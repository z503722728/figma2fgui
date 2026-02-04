import { UINode } from "../models/UINode";
import { ObjectType } from "../models/FGUIEnum";

/**
 * VectorMerger: Optimizes the UI tree by merging groups of vectors into a single SVG node.
 */
export class VectorMerger {
    
    public merge(nodes: UINode[]): void {
        for (const node of nodes) {
            this.processNode(node);
        }
    }

    private processNode(node: UINode): void {
        if (!node.children || node.children.length === 0) return;

        // 1. Process children first (Bottom-Up)
        for (const child of node.children) {
            this.processNode(child);
        }

        // 2. Check if this node is a candidate for merging
        // Candidate: Group or Component/Instance with ONLY vector/shape children
        // 💡 Restriction: Do NOT merge nodes that are already marked for extraction (asComponent) 
        // Or that are root-level components we want to keep as XML.
        if ((node.type === ObjectType.Group || node.type === ObjectType.Component) && !node.asComponent) {
            if (this.canMerge(node)) {
                this.performMerge(node);
            }
        }
    }

    private canMerge(node: UINode): boolean {
        if (!node.children || node.children.length === 0) return false; 

        let allValid = true;
        for (const child of node.children) {
            const hasFillPaths = Array.isArray(child.customProps?.fillGeometry) && child.customProps.fillGeometry.length > 0;
            const hasMergedPaths = Array.isArray(child.customProps?.mergedPaths) && child.customProps.mergedPaths.length > 0;
            const hasPaths = hasFillPaths || hasMergedPaths;

            const isVectorType = child.type === ObjectType.Image || child.type === ObjectType.Graph || child.type === ObjectType.Component || child.type === ObjectType.Group;
            const hasText = child.type === ObjectType.Text || (child.text && child.text.trim().length > 0);
            
            // 💡 Ghost Node Logic: If it has NO paths, NO text, and NO children, we can ignore it.
            // It's likely a layout guide or empty vector.
            const isGhostNode = !hasPaths && !hasText && (!child.children || child.children.length === 0);

            if (isGhostNode) {
                continue; // Skip ghost nodes, they don't block anything
            }

            if (!isVectorType || !hasPaths || hasText) {
                allValid = false;
                break;
            }
        }

        if (!allValid && (node.name.includes("AvatarRender") || node.children.length > 5)) {
            console.log(`  [VectorMerger] 🚫 Node '${node.name}' (${node.id}) cannot merge. Child Breakdown:`);
            node.children.forEach(c => {
                const hf = Array.isArray(c.customProps?.fillGeometry) && c.customProps.fillGeometry.length > 0;
                const hm = Array.isArray(c.customProps?.mergedPaths) && c.customProps.mergedPaths.length > 0;
                console.log(`    - '${c.name}' (${c.id}): Type=${ObjectType[c.type]}, hasPaths=${hf || hm}, isGhost=${!hf && !hm && (!c.children || c.children.length === 0)}`);
            });
        }

        return allValid;
    }

    private performMerge(node: UINode): void {
        console.log(`🌪️ [VectorMerger] Merging ${node.children.length} vectors in '${node.name}' (${node.id}) into single SVG.`);

        const mergedPaths: any[] = [];

        // 1. If Parent has background, add it as a base path
        // 💡 Fix: Ignore container background for merged vectors (user wants transparent icons generally)
        /*
        if (node.styles.fillColor && node.styles.fillType === 'solid') {
             mergedPaths.push({
                 type: 'rect',
                 x: 0,
                 y: 0,
                 width: node.width,
                 height: node.height,
                 fillColor: node.styles.fillColor,
                 cornerRadius: node.styles.cornerRadius || 0
             });
        }
        */

        // 2. Collect Child Paths
        for (const child of node.children) {
            const childX = child.x;
            const childY = child.y;
            
            // 💡 Fix: Prioritize already merged paths (nested flattenings)
            // AND ensure fillGeometry actually has content.
            const hasFillPaths = Array.isArray(child.customProps?.fillGeometry) && child.customProps.fillGeometry.length > 0;
            const hasMergedPaths = Array.isArray(child.customProps?.mergedPaths) && child.customProps.mergedPaths.length > 0;

            if (hasMergedPaths) {
                // Already merged child (nested flattened group)
                const childPaths = child.customProps.mergedPaths;
                console.log(`  [VectorMerger] Collecting ${childPaths.length} already merged paths from '${child.name}' (${child.id})`);
                childPaths.forEach((p: any) => {
                    mergedPaths.push({
                        ...p,
                        x: p.x + childX, 
                        y: p.y + childY
                    });
                });
            } else if (hasFillPaths) {
                // Single Vector or Graph Child
                const paths = child.customProps.fillGeometry;
                console.log(`  [VectorMerger] Collecting ${paths.length} paths from geometry in '${child.name}' (${child.id})`);
                paths.forEach((p: any) => {
                    mergedPaths.push({
                        type: 'path',
                        path: p.path,
                        x: childX,
                        y: childY,
                        fillColor: child.styles.fillColor || (child.type === ObjectType.Graph ? "#FFFFFF" : "#000000"), // Default to white for graphs if no color
                        strokeColor: child.styles.strokeColor,
                        strokeSize: child.styles.strokeSize
                    });
                });
            } else {
                console.log(`  [VectorMerger] ⚠️ Child '${child.name}' (${child.id}) (Type: ${ObjectType[child.type]}) contribution skipped (no data).`);
            }
        }

        // 3. Transform Node
        node.type = ObjectType.Image;
        node.customProps.mergedPaths = mergedPaths;
        console.log(`  [VectorMerger] ✅ Node '${node.name}' (${node.id}) transformed to Image with ${mergedPaths.length} paths.`);
        
        node.children = []; // Remove children
        node.asComponent = false; // Prevent sub-component extraction
        
        // 4. Update Styles
        node.styles.fillType = 'image'; // Mark as image for layout engines logic
    }
}
