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
import { ButtonHandler } from './ButtonHandler';

export class HandlerRegistry {
    private _handlers = new Map<ObjectType, INodeHandler>();
    private _componentRefHandler: ComponentRefHandler;
    private _containerHandler: ContainerHandler;
    private _buttonHandler: ButtonHandler;

    constructor() {
        this._componentRefHandler = new ComponentRefHandler();
        this._containerHandler = new ContainerHandler();
        this._buttonHandler = new ButtonHandler();

        const textHandler = new TextHandler();
        const imageHandler = new ImageHandler();
        const loaderHandler = new LoaderHandler();
        const graphHandler = new GraphHandler();
        const listHandler = new ListHandler();

        this._handlers.set(ObjectType.Text, textHandler);
        this._handlers.set(ObjectType.InputText, textHandler);
        this._handlers.set(ObjectType.Image, imageHandler);
        this._handlers.set(ObjectType.Loader, loaderHandler);
        this._handlers.set(ObjectType.Graph, graphHandler);
        this._handlers.set(ObjectType.List, listHandler);

        // Button 独立处理（controller 声明、gearIcon/gearDisplay/gearXY 输出）
        this._handlers.set(ObjectType.Button, this._buttonHandler);

        // 其他容器类型共用 ContainerHandler
        [ObjectType.Component, ObjectType.Group,
         ObjectType.ProgressBar, ObjectType.Slider, ObjectType.ComboBox, ObjectType.Label
        ].forEach(t => this._handlers.set(t, this._containerHandler));
    }

    getHandler(node: UINode): INodeHandler {
        if (node.asComponent && node.src) return this._componentRefHandler;
        return this._handlers.get(node.type) || this._handlers.get(ObjectType.Graph)!;
    }

    getButtonHandler(): ButtonHandler {
        return this._buttonHandler;
    }
}
