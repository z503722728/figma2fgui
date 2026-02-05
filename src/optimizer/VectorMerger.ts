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

        // 2. Partial Merging Logic
        // Scan children for sequences of mergeable vectors
        if (node.type === ObjectType.Group || node.type === ObjectType.Component || node.type === ObjectType.Loader || node.type === ObjectType.Image) {
            
            const newChildren: UINode[] = [];
            let mergeBuffer: UINode[] = [];

            const flushBuffer = () => {
                if (mergeBuffer.length === 0) return;

                if (mergeBuffer.length === 1) {
                    newChildren.push(mergeBuffer[0]);
                } else {
                    // Create a temporary group to hold the buffer
                    // We need to calculate the bounding box for the new merged node
                    const minX = Math.min(...mergeBuffer.map(n => n.x));
                    const minY = Math.min(...mergeBuffer.map(n => n.y));
                    // Max X/Y logic is a bit complex due to width/height, stick to relative merge
                    
                    const tempGroup: UINode = {
                        id: `merged_${Math.random().toString(36).substr(2, 9)}`,
                        name: `img_${mergeBuffer.map(n => n.name).join('_').substring(0, 20)}`,
                        type: ObjectType.Group,
                        x: minX,
                        y: minY,
                        width: 0, // Will be recalculated or ignored by SVG generation relative pos
                        height: 0,
                        styles: {},
                        customProps: {},
                        children: mergeBuffer.map(c => {
                            // Adjust coordinates to be relative to the new group
                            const clone = { ...c };
                            clone.x -= minX;
                            clone.y -= minY;
                            return clone;
                        }),
                        visible: true
                    };

                    this.performMerge(tempGroup);
                    newChildren.push(tempGroup);
                }
                mergeBuffer = [];
            };

            for (const child of node.children) {
                if (this.isMergeable(child)) {
                    mergeBuffer.push(child);
                } else {
                    flushBuffer();
                    newChildren.push(child);
                }
            }
            flushBuffer();

            // Replace children with new merged list
            node.children = newChildren;
        }
    }

    private isMergeable(node: UINode): boolean {
        // Must NOT be an extracted component
        if (node.asComponent) return false;
        
        // Must NOT be Text
        if (node.type === ObjectType.Text || (node.text && node.text.trim().length > 0)) return false;

        // Must be a vector container or shape
        const isVectorType = node.type === ObjectType.Image || 
            node.type === ObjectType.Graph || 
            node.type === ObjectType.Component || 
            node.type === ObjectType.Group ||
            // 💡 Treat basic frames as mergeable if they have no text children (recursive check done by processNode bottom-up)
            node.type === ObjectType.Loader;

        if (!isVectorType) return false;

        // Must have paths or be a container of paths
        const hasFillPaths = Array.isArray(node.customProps?.fillGeometry) && node.customProps.fillGeometry.length > 0;
        const hasMergedPaths = Array.isArray(node.customProps?.mergedPaths) && node.customProps.mergedPaths.length > 0;
        
        // If it's a generic group/frame, check if it has children and ALL children are mergeable?
        // Actually, since we process bottom-up, if a child group wasn't merged into a single image, 
        // it means it had some non-mergeable content (like Text). 
        // So we can assume if it's still a Group/Frame here, it might be complex.
        // SIMPLIFICATION strategy: Only merge explicit vector nodes or nodes that have ALREADY been merged.
        
        if (hasFillPaths || hasMergedPaths) return true;

        // Ghost node check (hidden containers without paths) - treat as non-blocking but maybe skip?
        // Choosing to perform strict merge: only things that LOOK like vectors.
        return false;
    }

    private performMerge(node: UINode): void {
        console.log(`🌪️ [VectorMerger] Merging ${node.children.length} vectors in '${node.name}' into single SVG.`);

        const mergedPaths: any[] = [];
        let maxWidth = 0;
        let maxHeight = 0;

        // 1. Collect Child Paths
        for (const child of node.children) {
            const childX = child.x;
            const childY = child.y;
            
            // Track size (rough approximation)
            maxWidth = Math.max(maxWidth, childX + child.width);
            maxHeight = Math.max(maxHeight, childY + child.height);

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
        
        // Update size to fit content
        if (node.width === 0) node.width = maxWidth;
        if (node.height === 0) node.height = maxHeight;
    }
}
