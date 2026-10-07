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
import { fmtDayLabel } from './format.js';
const SVG_NS = 'http://www.w3.org/2000/svg';
/** 环形图几何常量（viewBox 100×100）。 */
const VIEW = 100;
const CENTER = VIEW / 2;
const RADIUS_OUTER = 44;
const RADIUS_INNER = 29;
/** 扇区外移距离（viewBox 单位）。 */
const EXPLODE = 3;
/** 柱状图最大像素高度（与 CSS 的 .dus-chart 高度一致）。 */
const BAR_MAX_PX = 88;
/** 创建 SVG 元素。 */
function svgEl(tag) {
    return document.createElementNS(SVG_NS, tag);
}
/** 极坐标 → 笛卡尔（0 弧度指向 12 点方向，顺时针为正）。 */
function polar(radius, angle) {
    return [CENTER + radius * Math.cos(angle - Math.PI / 2), CENTER + radius * Math.sin(angle - Math.PI / 2)];
}
/**
 * 生成一段环形扇区的路径。
 * @param start - 起始弧度。
 * @param end - 结束弧度。
 * @returns SVG `d` 属性值。
 */
function donutPath(start, end) {
    const span = end - start;
    // 整圆（单扇区占 100%）走两段半弧：起点与终点重合时单段 A 弧不会被渲染。
    if (span >= Math.PI * 2 - 1e-6) {
        const [outerTopX, outerTopY] = polar(RADIUS_OUTER, 0);
        const [outerBottomX, outerBottomY] = polar(RADIUS_OUTER, Math.PI);
        const [innerTopX, innerTopY] = polar(RADIUS_INNER, 0);
        const [innerBottomX, innerBottomY] = polar(RADIUS_INNER, Math.PI);
        return [
            `M ${outerTopX} ${outerTopY}`,
            `A ${RADIUS_OUTER} ${RADIUS_OUTER} 0 1 1 ${outerBottomX} ${outerBottomY}`,
            `A ${RADIUS_OUTER} ${RADIUS_OUTER} 0 1 1 ${outerTopX} ${outerTopY}`,
            `M ${innerTopX} ${innerTopY}`,
            `A ${RADIUS_INNER} ${RADIUS_INNER} 0 1 0 ${innerBottomX} ${innerBottomY}`,
            `A ${RADIUS_INNER} ${RADIUS_INNER} 0 1 0 ${innerTopX} ${innerTopY}`,
            'Z',
        ].join(' ');
    }
    const largeArc = span > Math.PI ? 1 : 0;
    const [x1, y1] = polar(RADIUS_OUTER, start);
    const [x2, y2] = polar(RADIUS_OUTER, end);
    const [x3, y3] = polar(RADIUS_INNER, end);
    const [x4, y4] = polar(RADIUS_INNER, start);
    return [
        `M ${x1} ${y1}`,
        `A ${RADIUS_OUTER} ${RADIUS_OUTER} 0 ${largeArc} 1 ${x2} ${y2}`,
        `L ${x3} ${y3}`,
        `A ${RADIUS_INNER} ${RADIUS_INNER} 0 ${largeArc} 0 ${x4} ${y4}`,
        'Z',
    ].join(' ');
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
export function createDonut(host, onHover) {
    const wrap = document.createElement('div');
    wrap.className = 'dus-pie-wrap';
    const svg = svgEl('svg');
    svg.setAttribute('viewBox', `0 0 ${VIEW} ${VIEW}`);
    svg.setAttribute('class', 'dus-pie-svg');
    const center = document.createElement('div');
    center.className = 'dus-pie-center';
    const title = document.createElement('div');
    title.className = 'dus-pie-title';
    const sub = document.createElement('div');
    sub.className = 'dus-pie-sub';
    center.append(title, sub);
    wrap.append(svg, center);
    host.append(wrap);
    /** 当前渲染的扇区，保存各自的监听器引用以便精确解绑。 */
    let paths = [];
    const clearHot = () => {
        svg.classList.remove('hovering');
        for (const entry of paths)
            entry.node.classList.remove('hot');
        onHover?.(null);
    };
    const setHot = (key) => {
        svg.classList.add('hovering');
        let hot = null;
        for (const entry of paths) {
            const isHot = entry.slice.key === key;
            entry.node.classList.toggle('hot', isHot);
            if (isHot)
                hot = entry.slice;
        }
        if (hot !== null)
            onHover?.(hot);
    };
    const leave = () => clearHot();
    const detach = () => {
        for (const entry of paths) {
            entry.node.removeEventListener('pointerenter', entry.enter);
            entry.node.removeEventListener('pointerleave', leave);
        }
        paths = [];
    };
    return {
        update(slices, centerTitle, centerSub) {
            title.textContent = centerTitle;
            sub.textContent = centerSub;
            detach();
            svg.textContent = '';
            svg.classList.remove('hovering');
            const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
            if (total <= 0) {
                const empty = svgEl('circle');
                empty.setAttribute('cx', String(CENTER));
                empty.setAttribute('cy', String(CENTER));
                empty.setAttribute('r', String(RADIUS_OUTER));
                empty.setAttribute('class', 'dus-pie-empty');
                svg.append(empty);
                return;
            }
            let angle = 0;
            for (const slice of slices) {
                const span = (Math.max(0, slice.value) / total) * Math.PI * 2;
                const path = svgEl('path');
                path.setAttribute('d', donutPath(angle, angle + span));
                path.setAttribute('fill', slice.color);
                path.setAttribute('class', 'dus-slice');
                path.dataset['key'] = slice.key;
                // 沿角平分线外移的方向交给 CSS 变量：SVG 元素直接 scale 会以原点为
                // 基准缩放而飞出去（transform-box 的坑），translate 则稳定可预期。
                const [dx, dy] = polar(EXPLODE, angle + span / 2);
                path.style.setProperty('--tx', `${dx - CENTER}px`);
                path.style.setProperty('--ty', `${dy - CENTER}px`);
                const enter = () => setHot(slice.key);
                path.addEventListener('pointerenter', enter);
                path.addEventListener('pointerleave', leave);
                svg.append(path);
                paths.push({ node: path, enter, slice });
                angle += span;
            }
        },
        setCenter(centerTitle, centerSub) {
            title.textContent = centerTitle;
            sub.textContent = centerSub;
        },
        dispose() {
            detach();
            wrap.remove();
        },
    };
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
export function createBars(host, axisHost, onSelect) {
    const tooltip = document.createElement('div');
    tooltip.className = 'dus-tooltip';
    tooltip.style.display = 'none';
    host.append(tooltip);
    const hide = () => {
        tooltip.style.display = 'none';
    };
    const show = (bar, text) => {
        tooltip.textContent = text;
        tooltip.style.display = 'block';
        const barRect = bar.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        const width = tooltip.offsetWidth;
        let left = barRect.left - hostRect.left + barRect.width / 2 - width / 2;
        left = Math.max(0, Math.min(left, Math.max(0, hostRect.width - width)));
        tooltip.style.left = `${Math.round(left)}px`;
        tooltip.style.bottom = `${Math.round(hostRect.bottom - barRect.top + 6)}px`;
    };
    return {
        update(bars, selectedKey, labelEvery) {
            host.textContent = '';
            host.append(tooltip);
            hide();
            axisHost.textContent = '';
            if (bars.length === 0)
                return;
            const max = Math.max(...bars.map((bar) => bar.value), 1);
            const step = Math.max(1, Math.round(labelEvery));
            const todayKey = bars[bars.length - 1]?.key ?? '';
            bars.forEach((bar, index) => {
                const node = document.createElement('div');
                node.className = bar.today ? 'dus-bar today' : 'dus-bar';
                if (bar.key === selectedKey)
                    node.classList.add('selected');
                node.style.height = `${Math.max(2, Math.round((bar.value / max) * BAR_MAX_PX))}px`;
                node.addEventListener('pointerenter', () => show(node, bar.tooltip));
                node.addEventListener('pointerleave', hide);
                node.addEventListener('click', () => {
                    onSelect(bar.key);
                });
                host.append(node);
                const label = document.createElement('span');
                const visible = index % step === 0 || index === bars.length - 1;
                label.textContent = visible ? fmtDayLabel(bar.key, todayKey) : '';
                label.title = bar.key;
                axisHost.append(label);
            });
        },
        dispose() {
            tooltip.remove();
        },
    };
}
//# sourceMappingURL=chart.js.map