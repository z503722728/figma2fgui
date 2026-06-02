export enum ObjectType {
    Image = 0,
    MovieClip = 1,
    Sound = 2,
    Graph = 3,
    Loader = 4,
    Group = 5,
    Text = 6,
    RichText = 7,
    InputText = 8,
    Component = 9,
    List = 10,
    Label = 11,
    Button = 12,
    ComboBox = 13,
    ProgressBar = 14,
    Slider = 15,
    ScrollBar = 16,
    Tree = 17,
    Loader3D = 18
}

/**
 * Button 的三种工作模式（对应 FGUI 「创建按钮」对话框的「按钮模式」）
 *
 *  Common  = 普通按钮：点击触发，无保持状态
 *  Check   = 复选按钮：可 selected/unselected 切换（Toggle 开关就是这种）
 *  Radio   = 单选按钮：同组互斥，同一时刻只有一个选中
 *
 * 在 FGUI XML 中通过 <Button mode="Check"/> 或 <Button mode="Radio"/> 声明。
 * 默认不写 mode 则为 Common。
 */
export enum ButtonMode {
    Common = 'Common',
    Check  = 'Check',
    Radio  = 'Radio',
}

/**
 * Gear（齿轮）类型 — 用于控制器驱动的属性动画
 * 来自 lib.js GearType 数组
 */
export enum GearType {
    gearDisplay  = 'gearDisplay',   // 显示/隐藏
    gearXY       = 'gearXY',        // 位置
    gearSize     = 'gearSize',       // 尺寸
    gearLook     = 'gearLook',       // 外观（颜色/透明）
    gearColor    = 'gearColor',      // 颜色
    gearAni      = 'gearAni',        // 动画帧
    gearText     = 'gearText',       // 文字内容
    gearIcon     = 'gearIcon',       // 图标/图片
    gearDisplay2 = 'gearDisplay2',   // 显示/隐藏2（反向）
    gearFontSize = 'gearFontSize',   // 字号
}

export enum LoaderFillType {
    none            = 0,
    scale           = 1,
    scaleMatchHeight= 2,
    scaleMatchWidth = 3,
    scaleFree       = 4,
    scaleNoBorder   = 5
}

/**
 * Graph 形状类型
 */
export enum GraphType {
    none            = 'none',
    rect            = 'rect',
    ellipse         = 'eclipse',   // FGUI 源码里的拼写是 "eclipse"（原始错误，保持兼容）
    polygon         = 'polygon',
    regular_polygon = 'regular_polygon',
}

/**
 * 文本自动大小模式
 */
export enum AutoSizeType {
    none   = 'none',
    both   = 'both',
    height = 'height',
    shrink = 'shrink',
}

/**
 * 滚动条显示类型
 */
export enum ScrollBarDisplayType {
    default = 'default',
    visible = 'visible',
    auto    = 'auto',
    hidden  = 'hidden',
}

/**
 * 滚动方向
 */
export enum ScrollType {
    horizontal = 'horizontal',
    vertical   = 'vertical',
    both       = 'both',
}

/**
 * 列表布局类型
 */
export enum ListLayoutType {
    column     = 'column',
    row        = 'row',
    flow_hz    = 'flow_hz',
    flow_vt    = 'flow_vt',
    pagination = 'pagination',
}

/**
 * 列表选择模式
 */
export enum ListSelectionMode {
    single              = 'single',
    multiple            = 'multiple',
    multipleSingleClick = 'multipleSingleClick',
    none                = 'none',
}

/**
 * 进度条标题类型
 */
export enum ProgressTitleType {
    percent     = 'percent',
    valueAndmax = 'valueAndmax',
    value       = 'value',
    max         = 'max',
}

/**
 * 填充方式（ProgressBar/图片填充动画）
 */
export enum FillMethodType {
    None      = 'None',
    hz        = 'hz',
    vt        = 'vt',
    radial90  = 'radial90',
    radial180 = 'radial180',
    radial360 = 'radial360',
}

export enum AlignType {
    left   = 'left',
    center = 'center',
    right  = 'right'
}

export enum VertAlignType {
    top    = 'top',
    middle = 'middle',
    bottom = 'bottom'
}

export enum RelationType {
    Left_Left     = "left-left",
    Left_Center   = "left-center",
    Left_Right    = "left-right",
    Center_Center = "center-center",
    Right_Left    = "right-left",
    Right_Center  = "right-center",
    Right_Right   = "right-right",
    Top_Top       = "top-top",
    Top_Middle    = "top-middle",
    Top_Bottom    = "top-bottom",
    Middle_Middle = "middle-middle",
    Bottom_Top    = "bottom-top",
    Bottom_Middle = "bottom-middle",
    Bottom_Bottom = "bottom-bottom",
    Width_Width   = "width-width",
    Height_Height = "height-height"
}
