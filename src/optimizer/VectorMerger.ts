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
        // Candidate: Group or Component with ONLY vector children
        if (node.type === ObjectType.Group || node.type === ObjectType.Component) {
            if (this.canMerge(node)) {
                this.performMerge(node);
            }
        }
    }

    private canMerge(node: UINode): boolean {
        if (node.children.length < 2) return false; // Don't bother merging single items (unless we want to flatten structure?)

        for (const child of node.children) {
            // Must be an Image (Vector) and have path data
            // Or be a merged vector itself (recursive merge?) -> Yes, if type is Image and has mergedPaths
            const isVector = (child.type === ObjectType.Image && (child.customProps?.fillGeometry || child.customProps?.mergedPaths));
            
            if (!isVector) {
                return false;
            }

            // Also check for complex props we can't handle yet?
            // e.g. text? (Filtered by type check above)
            // e.g. 9-slice? (Figma doesn't have 9-slice on vectors usually)
        }
        return true;
    }

    private performMerge(node: UINode): void {
        console.log(`🌪️ [VectorMerger] Merging ${node.children.length} vectors in '${node.name}' into single SVG.`);

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
            
            if (child.customProps?.fillGeometry) {
                // Single Vector Child
                const paths = child.customProps.fillGeometry;
                if (Array.isArray(paths)) {
                    paths.forEach(p => {
                        mergedPaths.push({
                            type: 'path',
                            path: p.path,
                            x: childX,
                            y: childY, // Path needs translation
                            fillColor: child.styles.fillColor || "#000000",
                            strokeColor: child.styles.strokeColor,
                            strokeSize: child.styles.strokeSize
                        });
                    });
                }
            } else if (child.customProps?.mergedPaths) {
                // Already merged child (nested flattened group)
                // We need to re-parent its paths
                const childPaths = child.customProps.mergedPaths;
                childPaths.forEach((p: any) => {
                    mergedPaths.push({
                        ...p,
                        x: p.x + childX, // Accumulate coordinate offset
                        y: p.y + childY
                    });
                });
            }
        }

        // 3. Transform Node
        node.type = ObjectType.Image;
        node.customProps.mergedPaths = mergedPaths;
        node.children = []; // Remove children
        node.asComponent = false; // Prevent sub-component extraction
        
        // 4. Update Styles
        node.styles.fillType = 'image'; // Mark as image for layout engines logic
    }
}
