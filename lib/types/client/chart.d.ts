/**
 * 纯 DOM / SVG 图表：可点击柱状图 + 可交互环形饼图。
 *
 * 刻意不引入图表库：client bundle 由 tsdown 打进 `lib/client.js`，任何第三方
 * 图表库都会成倍放大体积，而这里只需要「一根柱子」和「一段圆弧」两种图元。
 *
 * 交互规约：
 * - 环形图 hover 时被指扇区沿角平分线**外移**（饼图经典的 explode 效果），
 *   其余扇区降透明度；环心文本由调用方传入。
 * - 柱状图点击某根柱子把日期回传给调用方做全板块联动。
 *
 * @module @dsh-external/dsh-usage-stats/client/chart
 */
/** 一片饼图数据。 */
export interface Slice {
    /** 稳定标识（图例开关按它记忆）。 */
    key: string;
    /** 显示名。 */
    label: string;
    /** 数值（决定角度）。 */
    value: number;
    /** 调色板颜色。 */
    color: string;
    /** 附加说明，用于图例副文本（如费用、耗时）。 */
    detail?: string;
}
/** 环形图控制器。 */
export interface DonutController {
    /**
     * 用新数据重绘。
     * @param slices - 已按调用方口径过滤（隐藏项不传进来）的切片，按显示顺序。
     * @param centerTitle - 环心主文本（默认态）。
     * @param centerSub - 环心副文本（默认态）。
     */
    update(slices: Slice[], centerTitle: string, centerSub: string): void;
    /** 直接改写环心文本（hover 时由调用方覆盖，用于显示被指扇区）。 */
    setCenter(title: string, sub: string): void;
    /** 释放事件监听与容器。 */
    dispose(): void;
}
/**
 * 建一个环形饼图并挂到宿主元素。
 *
 * 宿主内追加 `div.dus-pie-wrap`（含 `svg` 与环心覆盖层）；后续
 * {@link DonutController.update} 只重建扇区，不重建容器。
 * @param host - 承载容器。
 * @param onHover - hover 回调：进入扇区传该切片，离开传 null（调用方据此改环心）。
 * @returns 控制器。
 */
export declare function createDonut(host: HTMLElement, onHover?: (slice: Slice | null) => void): DonutController;
/** 一根柱子。 */
export interface Bar {
    /** 日期键 `YYYY-MM-DD`。 */
    key: string;
    /** 柱高依据（tokens）。 */
    value: number;
    /** 浮层内容（多行文本，`\n` 换行）。 */
    tooltip: string;
    /** 是否为今天。 */
    today: boolean;
}
/** 柱状图控制器。 */
export interface BarsController {
    /**
     * 重绘柱子与横轴。
     * @param bars - 数据（按时间升序）。
     * @param selectedKey - 当前选中日期；null 表示未选中。
     * @param labelEvery - 横轴标签抽稀步长（1 = 全显示）。
     */
    update(bars: Bar[], selectedKey: string | null, labelEvery: number): void;
    /** 释放浮层。 */
    dispose(): void;
}
/**
 * 建一个可点击的柱状图（柱子 + 横轴 + hover 浮层）。
 *
 * 用 div 而非 SVG：柱状图只需高度与颜色，flex 自适应宽度在 90 天档比手算坐标
 * 省事。浮层是绝对定位 div（比原生 `title` 可控、可多行），贴近边缘时自动收拢。
 * @param host - 柱子容器（CSS 已给它 `position: relative`）。
 * @param axisHost - 横轴标签容器。
 * @param onSelect - 点击柱子回调（点击已选中柱子也会回调，由调用方决定取消）。
 * @returns 控制器。
 */
export declare function createBars(host: HTMLElement, axisHost: HTMLElement, onSelect: (key: string) => void): BarsController;
