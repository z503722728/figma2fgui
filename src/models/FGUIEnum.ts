/**
 * FGUI Object Types based on reverse engineered source.
 */
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
 * FGUI Loader Fill Types.
 */
export enum LoaderFillType {
    none = 0,
    scale = 1,
    scaleMatchHeight = 2,
    scaleMatchWidth = 3,
    scaleFree = 4,
    scaleNoBorder = 5
}

/**
 * FGUI Align Types.
 */
export enum AlignType {
    left = 'left',
    center = 'center',
    right = 'right'
}

export enum VertAlignType {
    top = 'top',
    middle = 'middle',
    bottom = 'bottom'
}

/**
 * FGUI Relation Types.
 */
export enum RelationType {
    Left_Left = "left-left",
    Left_Center = "left-center",
    Left_Right = "left-right",
    Center_Center = "center-center",
    Right_Left = "right-left",
    Right_Center = "right-center",
    Right_Right = "right-right",
    Top_Top = "top-top",
    Top_Middle = "top-middle",
    Top_Bottom = "top-bottom",
    Middle_Middle = "middle-middle",
    Bottom_Top = "bottom-top",
    Bottom_Middle = "bottom-middle",
    Bottom_Bottom = "bottom-bottom",
    Width_Width = "width-width",
    Height_Height = "height-height"
}
