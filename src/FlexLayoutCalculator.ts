import Yoga from 'yoga-layout';
import { UINode } from './models/UINode';

/**
 * FlexLayoutCalculator: 使用 Yoga 引擎计算 Flexbox 布局
 */
export class FlexLayoutCalculator {
    public calculate(rootNodes: UINode[]): void {
        console.log("📐 开始计算 Flexbox 布局...");
        
        rootNodes.forEach(node => {
            const yogaRoot = this.buildYogaTree(node);
            
            // 触发计算 (Yoga 会根据节点属性算出精确坐标)
            yogaRoot.calculateLayout(node.width, node.height, Yoga.DIRECTION_LTR);
            
            // 将计算出的结果写回 UINode 树
            this.applyYogaResults(node, yogaRoot);
            
            // 释放 Yoga 内存
            yogaRoot.freeRecursive();
        });
    }

    private buildYogaTree(node: UINode): Yoga.YogaNode {
        const yogaNode = Yoga.Node.create();
        const s = node.styles || {};

        // 1. 设置尺寸
        if (node.width) yogaNode.setWidth(node.width);
        if (node.height) yogaNode.setHeight(node.height);

        // 2. 映射 Flex 属性 (CSS -> Yoga)
        // 增加更严格的 Flex 判断
        const isFlex = s.display === 'flex' || s.flexDirection || s.justifyContent || s.alignItems || s.gap;
        
        if (isFlex && node.children && node.children.length > 0) {
            yogaNode.setFlexDirection(this.mapFlexDirection(s.flexDirection));
            yogaNode.setJustifyContent(this.mapJustifyContent(s.justifyContent));
            yogaNode.setAlignItems(this.mapAlignItems(s.alignItems));
            
            if (s.gap) {
                const gapVal = parseFloat(s.gap);
                yogaNode.setGap(Yoga.GUTTER_ALL, gapVal);
            }
            if (s.paddingTop) yogaNode.setPadding(Yoga.EDGE_TOP, parseFloat(s.paddingTop));
            if (s.paddingBottom) yogaNode.setPadding(Yoga.EDGE_BOTTOM, parseFloat(s.paddingBottom));
            if (s.paddingLeft) yogaNode.setPadding(Yoga.EDGE_LEFT, parseFloat(s.paddingLeft));
            if (s.paddingRight) yogaNode.setPadding(Yoga.EDGE_RIGHT, parseFloat(s.paddingRight));
        } else {
            // 如果不是 Flex 容器，为了保持原始设计，我们需要将其子节点设为绝对定位
            // 但 Yoga 默认是 Flex 布局，所以非 Flex 容器的子节点应该设为 PositionType.Absolute
        }

        // 3. 递归构建子节点
        if (node.children) {
            node.children.forEach((child, index) => {
                const yogaChild = this.buildYogaTree(child);
                
                // 💡 核心逻辑：如果父节点不是 Flex，或者子节点有明确的 left/top，则设为绝对定位
                const hasPos = child.styles?.left !== undefined || child.styles?.top !== undefined;
                
                // Fix: 即使没有 left/top style，如果 RawFigmaParser 已经算好了 x/y，我们也应该使用它们
                if (!isFlex || hasPos) {
                    yogaChild.setPositionType(Yoga.POSITION_TYPE_ABSOLUTE);
                    
                    const leftVal = child.styles?.left !== undefined ? parseFloat(child.styles.left) : child.x;
                    const topVal = child.styles?.top !== undefined ? parseFloat(child.styles.top) : child.y;
                    
                    if (!isNaN(leftVal)) yogaChild.setPosition(Yoga.EDGE_LEFT, leftVal);
                    if (!isNaN(topVal)) yogaChild.setPosition(Yoga.EDGE_TOP, topVal);
                }
                
                yogaNode.insertChild(yogaChild, index);
            });
        }

        return yogaNode;
    }

    private applyYogaResults(node: UINode, yogaNode: Yoga.YogaNode, accumX: number = 0, absY: number = 0): void {
        const layout = yogaNode.getComputedLayout();
        
        // Yoga 返回的是相对于直接父级的偏移
        node.x = Math.round(layout.left);
        node.y = Math.round(layout.top);
        node.width = Math.round(layout.width);
        node.height = Math.round(layout.height);

        // 调试日志
        if (node.name.includes("Bridge") || node.text === "Shapes") {
            console.log(`[YogaDebug] Node: ${node.name}`);
            console.log(`  Before Yoga -> x: ${node.x}, y: ${node.y}`);
            console.log(`  Yoga Output -> left: ${layout.left}, top: ${layout.top}`);
        }
        
        // node.x = Math.round(layout.left);
        // node.y = Math.round(layout.top);
        
        // 💡 Fix: Keep original position if Yoga returns NaN or if we want to trust parser for Absolute items
        // But normally Yoga returns valid numbers.
        // If the node was absolute, Yoga should return the 'left/top' we set.
        
        node.x = Math.round(layout.left);
        node.y = Math.round(layout.top);
        if (node.children) {
            node.children.forEach((child, index) => {
                this.applyYogaResults(child, yogaNode.getChild(index));
            });
        }
    }

    private mapFlexDirection(val?: string): Yoga.YogaFlexDirection {
        if (val === 'column') return Yoga.FLEX_DIRECTION_COLUMN;
        return Yoga.FLEX_DIRECTION_ROW;
    }

    private mapJustifyContent(val?: string): Yoga.YogaJustify {
        switch (val) {
            case 'center': return Yoga.JUSTIFY_CENTER;
            case 'flex-start': return Yoga.JUSTIFY_FLEX_START;
            case 'flex-end': return Yoga.JUSTIFY_FLEX_END;
            case 'space-between': return Yoga.JUSTIFY_SPACE_BETWEEN;
            case 'space-around': return Yoga.JUSTIFY_SPACE_AROUND;
            default: return Yoga.JUSTIFY_FLEX_START;
        }
    }

    private mapAlignItems(val?: string): Yoga.YogaAlign {
        switch (val) {
            case 'center': return Yoga.ALIGN_CENTER;
            case 'flex-start': return Yoga.ALIGN_FLEX_START;
            case 'flex-end': return Yoga.ALIGN_FLEX_END;
            case 'stretch': return Yoga.ALIGN_STRETCH;
            default: return Yoga.ALIGN_STRETCH;
        }
    }
}
