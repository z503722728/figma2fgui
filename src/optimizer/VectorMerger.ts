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

        for (const child of node.children) {
            const hasFillPaths = Array.isArray(child.customProps?.fillGeometry) && child.customProps.fillGeometry.length > 0;
            const hasMergedPaths = Array.isArray(child.customProps?.mergedPaths) && child.customProps.mergedPaths.length > 0;
            const hasPaths = hasFillPaths || hasMergedPaths;

            const isVectorType = child.type === ObjectType.Image || child.type === ObjectType.Graph || child.type === ObjectType.Component || child.type === ObjectType.Group;
            const hasText = child.type === ObjectType.Text || (child.text && child.text.trim().length > 0);
            
            // Ghost Node Logic: If it has NO paths, NO text, and NO children, we can ignore it.
            const isGhostNode = !hasPaths && !hasText && (!child.children || child.children.length === 0);

            if (isGhostNode) continue;

            if (!isVectorType || !hasPaths || hasText) {
                return false;
            }
        }
        return true;
    }

    private performMerge(node: UINode): void {
        console.log(`🌪️ [VectorMerger] Merging ${node.children.length} vectors in '${node.name}' into single SVG.`);

        const mergedPaths: any[] = [];

        // 1. Collect Child Paths
        for (const child of node.children) {
            const childX = child.x;
            const childY = child.y;
            
            const hasFillPaths = Array.isArray(child.customProps?.fillGeometry) && child.customProps.fillGeometry.length > 0;
            const hasMergedPaths = Array.isArray(child.customProps?.mergedPaths) && child.customProps.mergedPaths.length > 0;

            if (hasMergedPaths) {
                const childPaths = child.customProps.mergedPaths;
                childPaths.forEach((p: any) => {
                    mergedPaths.push({
                        ...p,
                        x: p.x + childX, 
                        y: p.y + childY
                    });
                });
            } else if (hasFillPaths) {
                const paths = child.customProps.fillGeometry;
                paths.forEach((p: any) => {
                    // 💡 Improved: Default to 'none' if no fill/stroke to avoid solid black
                    const fillColor = child.styles.fillColor || "none";
                    const strokeColor = child.styles.strokeColor || "none";
                    
                    mergedPaths.push({
                        type: 'path',
                        path: p.path,
                        x: childX,
                        y: childY,
                        fillColor: fillColor,
                        fillOpacity: child.styles.fillOpacity ?? 1,
                        strokeColor: strokeColor,
                        strokeOpacity: child.styles.strokeOpacity ?? 1,
                        strokeSize: child.styles.strokeSize || 0,
                        gradient: child.styles.gradient,
                        filters: child.styles.filters,
                        imageFill: child.styles.imageFill,
                        rotation: child.rotation,
                        isMask: child.customProps.isMask,
                        maskType: child.customProps.maskType
                    });
                });
            }
        }

        // 2. Transform Node
        node.type = ObjectType.Image;
        node.customProps.mergedPaths = mergedPaths;
        node.children = []; 
        node.asComponent = false; 
        node.styles.fillType = 'image';
    }
}
