import { ObjectType } from '../../models/FGUIEnum';
import { UINode } from '../../models/UINode';
import { INodeHandler } from './INodeHandler';
import { TextHandler } from './TextHandler';
import { ImageHandler } from './ImageHandler';
import { LoaderHandler } from './LoaderHandler';
import { GraphHandler } from './GraphHandler';
import { ContainerHandler } from './ContainerHandler';
import { ListHandler } from './ListHandler';
import { ComponentRefHandler } from './ComponentRefHandler';

/**
 * HandlerRegistry: Handler 注册表。
 *
 * 根据 UINode 的类型和状态，返回对应的 INodeHandler 实例。
 * 支持 asComponent 节点的特殊路由。
 */
export class HandlerRegistry {
    private _handlers = new Map<ObjectType, INodeHandler>();
    private _componentRefHandler: ComponentRefHandler;
    private _containerHandler: ContainerHandler;

    constructor() {
        this._componentRefHandler = new ComponentRefHandler();
        this._containerHandler = new ContainerHandler();

        const textHandler = new TextHandler();
        const imageHandler = new ImageHandler();
        const loaderHandler = new LoaderHandler();
        const graphHandler = new GraphHandler();
        const listHandler = new ListHandler();

        // 注册基本类型
        this._handlers.set(ObjectType.Text, textHandler);
        this._handlers.set(ObjectType.InputText, textHandler);
        this._handlers.set(ObjectType.Image, imageHandler);
        this._handlers.set(ObjectType.Loader, loaderHandler);
        this._handlers.set(ObjectType.Graph, graphHandler);
        this._handlers.set(ObjectType.List, listHandler);

        // 容器类型统一使用 ContainerHandler
        const containerTypes = [
            ObjectType.Component,
            ObjectType.Group,
            ObjectType.Button,
            ObjectType.ProgressBar,
            ObjectType.Slider,
            ObjectType.ComboBox,
            ObjectType.Label,
        ];
        containerTypes.forEach(t => this._handlers.set(t, this._containerHandler));
    }

    /**
     * 根据节点状态和类型获取对应的 Handler。
     *
     * 优先级:
     *  1. asComponent && src → ComponentRefHandler
     *  2. 按 ObjectType 查找注册表
     *  3. 兜底使用 GraphHandler
     */
    getHandler(node: UINode): INodeHandler {
        // asComponent 引用节点使用专用 Handler
        if (node.asComponent && node.src) {
            return this._componentRefHandler;
        }

        return this._handlers.get(node.type) || this._handlers.get(ObjectType.Graph)!;
    }
}
