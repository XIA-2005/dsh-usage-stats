window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-usage-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		//#region src/client/format.ts
		/**
		* 面板展示层的数字与日期格式化。
		*
		* 纯函数、无 DOM 依赖，便于单独核对格式化口径。
		*
		* @module @dsh-external/dsh-usage-stats/client/format
		*/
		/** 千分位整数。 */
		function fmtInt(value) {
			return Math.round(value).toLocaleString("en-US");
		}
		/** token 缩写（K/M/B）；完整数值放元素的 title。 */
		function fmtTokens(value) {
			if (!Number.isFinite(value) || value <= 0) return "0";
			if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
			if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
			if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
			return String(Math.round(value));
		}
		/** 费用（CNY），按量级选小数位。 */
		function fmtCost(value) {
			if (!Number.isFinite(value) || value <= 0) return "¥0";
			if (value < .01) return `¥${value.toFixed(4)}`;
			if (value < 1) return `¥${value.toFixed(3)}`;
			return `¥${value.toFixed(2)}`;
		}
		/** 时长。 */
		function fmtDuration(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return "0ms";
			if (ms < 1e3) return `${Math.round(ms)}ms`;
			const seconds = ms / 1e3;
			if (seconds < 60) return `${seconds.toFixed(1)}s`;
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
			const hours = Math.floor(minutes / 60);
			return `${hours}h${minutes - hours * 60}m`;
		}
		/** 百分比（0–1 输入）。 */
		function fmtPercent(ratio, digits = 1) {
			if (!Number.isFinite(ratio) || ratio <= 0) return "0%";
			const percent = ratio * 100;
			return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(digits)}%`;
		}
		/**
		* 柱状图横轴的日期短标签。
		* @param date - `YYYY-MM-DD`。
		* @param todayKey - 今天的日历日键，用于显示「今天」。
		* @returns 今天显示「今天」，其余显示「MM-DD」。
		*/
		function fmtDayLabel(date, todayKey) {
			if (date === todayKey) return "今天";
			return date.length >= 10 ? date.slice(5) : date;
		}
		/** 时间戳 → 本地日期时间串。 */
		function fmtDateTime(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return "";
			return new Date(ms).toLocaleString("zh-CN", { hour12: false });
		}
		//#endregion
		//#region src/client/chart.ts
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
		const SVG_NS = "http://www.w3.org/2000/svg";
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
					"Z"
				].join(" ");
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
				"Z"
			].join(" ");
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
		function createDonut(host, onHover) {
			const wrap = document.createElement("div");
			wrap.className = "dus-pie-wrap";
			const svg = svgEl("svg");
			svg.setAttribute("viewBox", `0 0 ${VIEW} ${VIEW}`);
			svg.setAttribute("class", "dus-pie-svg");
			const center = document.createElement("div");
			center.className = "dus-pie-center";
			const title = document.createElement("div");
			title.className = "dus-pie-title";
			const sub = document.createElement("div");
			sub.className = "dus-pie-sub";
			center.append(title, sub);
			wrap.append(svg, center);
			host.append(wrap);
			/** 当前渲染的扇区，保存各自的监听器引用以便精确解绑。 */
			let paths = [];
			const clearHot = () => {
				svg.classList.remove("hovering");
				for (const entry of paths) entry.node.classList.remove("hot");
				onHover?.(null);
			};
			const setHot = (key) => {
				svg.classList.add("hovering");
				let hot = null;
				for (const entry of paths) {
					const isHot = entry.slice.key === key;
					entry.node.classList.toggle("hot", isHot);
					if (isHot) hot = entry.slice;
				}
				if (hot !== null) onHover?.(hot);
			};
			const leave = () => clearHot();
			const detach = () => {
				for (const entry of paths) {
					entry.node.removeEventListener("pointerenter", entry.enter);
					entry.node.removeEventListener("pointerleave", leave);
				}
				paths = [];
			};
			return {
				update(slices, centerTitle, centerSub) {
					title.textContent = centerTitle;
					sub.textContent = centerSub;
					detach();
					svg.textContent = "";
					svg.classList.remove("hovering");
					const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0);
					if (total <= 0) {
						const empty = svgEl("circle");
						empty.setAttribute("cx", String(CENTER));
						empty.setAttribute("cy", String(CENTER));
						empty.setAttribute("r", String(RADIUS_OUTER));
						empty.setAttribute("class", "dus-pie-empty");
						svg.append(empty);
						return;
					}
					let angle = 0;
					for (const slice of slices) {
						const span = Math.max(0, slice.value) / total * Math.PI * 2;
						const path = svgEl("path");
						path.setAttribute("d", donutPath(angle, angle + span));
						path.setAttribute("fill", slice.color);
						path.setAttribute("class", "dus-slice");
						path.dataset["key"] = slice.key;
						const [dx, dy] = polar(EXPLODE, angle + span / 2);
						path.style.setProperty("--tx", `${dx - CENTER}px`);
						path.style.setProperty("--ty", `${dy - CENTER}px`);
						const enter = () => setHot(slice.key);
						path.addEventListener("pointerenter", enter);
						path.addEventListener("pointerleave", leave);
						svg.append(path);
						paths.push({
							node: path,
							enter,
							slice
						});
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
				}
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
		function createBars(host, axisHost, onSelect) {
			const tooltip = document.createElement("div");
			tooltip.className = "dus-tooltip";
			tooltip.style.display = "none";
			host.append(tooltip);
			const hide = () => {
				tooltip.style.display = "none";
			};
			const show = (bar, text) => {
				tooltip.textContent = text;
				tooltip.style.display = "block";
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
					host.textContent = "";
					host.append(tooltip);
					hide();
					axisHost.textContent = "";
					if (bars.length === 0) return;
					const max = Math.max(...bars.map((bar) => bar.value), 1);
					const step = Math.max(1, Math.round(labelEvery));
					const todayKey = bars[bars.length - 1]?.key ?? "";
					bars.forEach((bar, index) => {
						const node = document.createElement("div");
						node.className = bar.today ? "dus-bar today" : "dus-bar";
						if (bar.key === selectedKey) node.classList.add("selected");
						node.style.height = `${Math.max(2, Math.round(bar.value / max * BAR_MAX_PX))}px`;
						node.addEventListener("pointerenter", () => show(node, bar.tooltip));
						node.addEventListener("pointerleave", hide);
						node.addEventListener("click", () => {
							onSelect(bar.key);
						});
						host.append(node);
						const label = document.createElement("span");
						label.textContent = index % step === 0 || index === bars.length - 1 ? fmtDayLabel(bar.key, todayKey) : "";
						label.title = bar.key;
						axisHost.append(label);
					});
				},
				dispose() {
					tooltip.remove();
				}
			};
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* 面板样式表。
		*
		* 全部使用 DSH 主题变量（`--theme-*`）并带回退色，因此在浅色/深色主题下都自洽。
		*
		* @module @dsh-external/dsh-usage-stats/client/styles
		*/
		/** 面板 CSS（由 panel 注入到 shadow-free 的 `<style>` 元素）。 */
		const STYLES = `
.dus-page{font-size:12px;line-height:1.5;padding:8px 2px 24px;max-width:880px;color:var(--theme-text,#ddd);font-family:inherit}
.dus-head{display:flex;align-items:center;gap:8px;margin:0 0 6px}
.dus-head h3{margin:0;font-size:13px;flex:1}
.dus-actions{display:flex;gap:6px}
.dus-btn{background:transparent;border:1px solid var(--theme-border,#444);color:var(--theme-text,#ccc);border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer}
.dus-btn:hover{border-color:var(--theme-accent,#4a9eff);color:var(--theme-accent,#4a9eff)}
.dus-btn:disabled{opacity:.45;cursor:not-allowed}
.dus-status{margin:0 0 12px;color:var(--theme-text-secondary,#888);font-size:11px}
.dus-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:14px}
.dus-card{border:1px solid var(--theme-border,#333);border-radius:8px;padding:9px 11px;background:var(--theme-input-bg,rgba(255,255,255,.02))}
.dus-card-label{font-size:11px;color:var(--theme-text-secondary,#888)}
.dus-card-value{font-size:17px;font-weight:600;margin:2px 0 1px;font-variant-numeric:tabular-nums}
.dus-card-sub{font-size:10px;color:var(--theme-text-secondary,#888)}
.dus-section{margin:0 0 8px;font-size:12px;font-weight:600}
.dus-bucket{display:grid;grid-template-columns:76px 1fr 96px;align-items:center;gap:8px;margin-bottom:3px}
.dus-bucket-label{color:var(--theme-text-secondary,#999);font-size:11px}
.dus-track{height:8px;border-radius:4px;background:var(--theme-border,#2a2a2a);overflow:hidden}
.dus-fill{height:100%;border-radius:4px;background:var(--theme-accent,#4a9eff);transition:width .3s ease}
.dus-fill.hit{background:#2ecc71}
.dus-fill.write{background:#e67e22}
.dus-fill.out{background:#9b59b6}
.dus-bucket-value{text-align:right;font-variant-numeric:tabular-nums;font-size:11px}
.dus-table{width:100%;border-collapse:collapse;margin-bottom:14px}
.dus-table th{text-align:left;font-weight:500;font-size:10px;color:var(--theme-text-secondary,#888);padding:0 6px 4px 0;border-bottom:1px solid var(--theme-border,#333)}
.dus-table td{padding:4px 6px 4px 0;border-bottom:1px solid var(--theme-border,#222);font-variant-numeric:tabular-nums}
.dus-table td.name{font-family:ui-monospace,monospace;font-size:11px;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dus-table td.num{text-align:right;width:78px}
.dus-table td.share{width:120px}
.dus-mini{height:6px;border-radius:3px;background:var(--theme-accent,#4a9eff);opacity:.75}
.dus-empty{color:var(--theme-text-secondary,#888);font-size:11px;padding:6px 0 12px}
.dus-warn{color:#f1c40f;font-size:11px;margin:0 0 8px}
.dus-warn button{background:transparent;border:1px solid #f1c40f;color:#f1c40f;border-radius:5px;padding:1px 7px;font-size:10px;cursor:pointer;margin-left:6px}

/* —— 趋势图控制条 —— */
.dus-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 8px}
.dus-seg{display:inline-flex;gap:2px;border:1px solid var(--theme-border,#444);border-radius:7px;padding:1px}
.dus-seg button{background:transparent;border:none;color:var(--theme-text-secondary,#999);border-radius:5px;padding:2px 9px;font-size:11px;cursor:pointer;font-family:inherit}
.dus-seg button:hover{color:var(--theme-text,#ddd)}
.dus-seg button.on{background:var(--theme-accent,#4a9eff);color:#fff}
.dus-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--theme-accent,#4a9eff);border-radius:12px;padding:2px 8px;font-size:11px}
.dus-chip button{background:transparent;border:none;color:inherit;cursor:pointer;font-size:13px;line-height:1;padding:0}

/* —— 柱状图 —— */
.dus-chart{position:relative;display:flex;align-items:flex-end;gap:3px;height:92px;margin:2px 0 4px;border-bottom:1px solid var(--theme-border,#333);padding-bottom:1px}
.dus-bar{flex:1;min-width:2px;min-height:2px;background:var(--theme-accent,#4a9eff);opacity:.65;border-radius:2px 2px 0 0;cursor:pointer;transition:opacity .15s ease,box-shadow .15s ease}
.dus-bar:hover{opacity:.9}
.dus-bar.today{opacity:1}
.dus-bar.selected{opacity:1;box-shadow:0 0 0 1.5px var(--theme-accent,#4a9eff),0 0 6px rgba(74,158,255,.5)}
.dus-axis{display:flex;gap:3px;font-size:9px;color:var(--theme-text-secondary,#888);margin-bottom:12px}
.dus-axis span{flex:1;min-width:2px;text-align:center;overflow:hidden;white-space:nowrap}
.dus-tooltip{position:absolute;z-index:5;background:var(--theme-panel,var(--theme-input-bg,#1e1e1e));border:1px solid var(--theme-border,#444);border-radius:6px;padding:5px 8px;font-size:10px;line-height:1.55;white-space:pre-line;color:var(--theme-text,#ddd);pointer-events:none;box-shadow:0 3px 12px rgba(0,0,0,.35);max-width:240px}

/* —— 环形饼图 —— */
.dus-pie-flex{display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
.dus-pie-wrap{position:relative;width:172px;height:172px;flex:0 0 auto}
.dus-pie-svg{width:100%;height:100%;overflow:visible;display:block}
.dus-slice{transition:transform .16s ease,opacity .16s ease;cursor:pointer;stroke:var(--theme-bg,rgba(0,0,0,.35));stroke-width:.5}
.dus-pie-svg.hovering .dus-slice{opacity:.35}
.dus-pie-svg.hovering .dus-slice.hot{opacity:1;transform:translate(var(--tx,0),var(--ty,0))}
.dus-pie-empty{fill:none;stroke:var(--theme-border,#333);stroke-width:9}
.dus-pie-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 40px;pointer-events:none;text-align:center}
.dus-pie-title{font-size:10px;color:var(--theme-text-secondary,#999);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dus-pie-sub{font-size:13px;font-weight:600;margin-top:2px;font-variant-numeric:tabular-nums}
.dus-legend{list-style:none;margin:0;padding:0;flex:1 1 240px;min-width:210px}
.dus-legend li{display:flex;align-items:center;gap:7px;padding:3px 5px;border-radius:5px;cursor:pointer;font-size:11px}
.dus-legend li:hover{background:var(--theme-input-bg,rgba(255,255,255,.05))}
.dus-legend li.off{opacity:.38}
.dus-legend li.off .sw{background:transparent!important;box-shadow:inset 0 0 0 1.5px var(--theme-text-secondary,#888)}
.dus-legend .sw{width:9px;height:9px;border-radius:2px;flex:0 0 auto}
.dus-legend .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dus-legend .vl{color:var(--theme-text-secondary,#999);font-variant-numeric:tabular-nums}
.dus-pie-sub2{color:var(--theme-text-secondary,#888);font-size:10px;margin:0 0 14px}
`;
		/** 饼图/图例调色板（12 色，深浅主题下都可辨识）。 */
		const PALETTE = [
			"#4a9eff",
			"#2ecc71",
			"#e67e22",
			"#9b59b6",
			"#e84393",
			"#00b8d4",
			"#f1c40f",
			"#7f8c8d",
			"#ff7675",
			"#55efc4",
			"#a29bfe",
			"#fab1a0"
		];
		/**
		* 取调色板颜色（按索引循环）。
		* @param index - 序号。
		* @returns 十六进制颜色。
		*/
		function paletteColor(index) {
			return PALETTE[index % PALETTE.length] ?? "#4a9eff";
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* @dsh-external/dsh-usage-stats —— 设置页「用量统计」面板（client 侧）。
		*
		* 构建：`npm run build:client`（tsdown → lib/client.js，ModuleLoader.load 注册）。
		*
		* 契约（照抄本机正在运行、已验证的 super-injector 设置页写法）：
		* - `export const inject = ['slots']`，否则 `ctx.slots` 未定义；
		* - `ctx.slots.register(options, component)` 的 component 是**第二个参数**，
		*   并且 register 要包在 `ctx.slots.inject(slotName, …)` 里；
		* - options 必须带 `name`（= slot 名），缺了会报 "slot undefined is not declared"。
		*
		* 数据流（两档，互不干扰）：
		* - **主轮询**（3 秒）拉 `/summary`：卡片、三张表、柱状图。选中日期后卡片与表格
		*   切到该日数据（来自明细），未选中时显示全局累计。
		* - **明细**（`/days`，按需 + 60 秒节流）：环形饼图与「选中某日」的数据源。
		*   交互本身（切维度、点图例、点柱子）不发请求，全部本地重绘。
		*
		* 交互状态（范围 / 选中日期 / 饼图维度 / 图例开关）都存在本闭包里，
		* 因此 3 秒轮询重绘不会把它们重置掉。
		*
		* @module @dsh-external/dsh-usage-stats/client
		*/
		/**
		* client 侧服务注入声明。
		*
		* 缺了它本模块的 fiber 不注入任何服务，`ctx.slots` 为 undefined，
		* `apply()` 里 `ctx.slots.inject(...)` 会抛 TypeError，前端整页报
		* `web boot: 1 entry did not activate / @dsh-external/dsh-usage-stats: failed`。
		*/
		const inject = ["slots"];
		/** host API 前缀（与 src/index.ts 的 API_PREFIX 一致）。 */
		const API = "/dsh-usage-stats/api";
		/** 主轮询间隔。 */
		const POLL_MS = 3e3;
		/** 明细的重新拉取节流（明细较大，不跟着 3 秒轮询走）。 */
		const DETAIL_TTL_MS = 6e4;
		/** 表格与排行的条数。 */
		const TOP = 12;
		/** 饼图里「其他」归并前的最大扇区数。 */
		const PIE_TOP_TOOLS = 8;
		const PIE_TOP_SESSIONS = 6;
		/** 四桶语义色（与条形图、图例保持一致）。 */
		const BUCKET_COLORS = {
			uncachedInputTokens: "#4a9eff",
			cacheReadTokens: "#2ecc71",
			cacheWriteTokens: "#e67e22",
			outputTokens: "#9b59b6"
		};
		/** 「其他」项的固定色。 */
		const OTHER_COLOR = "#7f8c8d";
		/** 范围按钮。 */
		const RANGES = [
			{
				key: 7,
				label: "7 天"
			},
			{
				key: 14,
				label: "14 天"
			},
			{
				key: 30,
				label: "30 天"
			},
			{
				key: 90,
				label: "90 天"
			},
			{
				key: "all",
				label: "全部"
			}
		];
		/** 饼图维度按钮。 */
		const MODES = [
			{
				key: "tokens",
				label: "token 构成"
			},
			{
				key: "models",
				label: "按模型"
			},
			{
				key: "tools",
				label: "按工具"
			},
			{
				key: "sessions",
				label: "按对话"
			}
		];
		/** 建元素助手。 */
		function el(tag, cls, text) {
			const node = document.createElement(tag);
			if (cls !== void 0) node.className = cls;
			if (text !== void 0) node.textContent = text;
			return node;
		}
		/** 空用量。 */
		function emptyUsage() {
			return {
				uncachedInputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				outputTokens: 0,
				costCny: 0
			};
		}
		/** 累加用量（就地）。 */
		function addUsage(target, source) {
			target.uncachedInputTokens += source.uncachedInputTokens;
			target.cacheReadTokens += source.cacheReadTokens;
			target.cacheWriteTokens += source.cacheWriteTokens;
			target.outputTokens += source.outputTokens;
			target.costCny += source.costCny;
		}
		/** 四桶合计。 */
		function usageTokens(usage) {
			return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
		}
		/** 北京日历日键（与 host 的 dayKey 同口径）。 */
		function beijingDayKey(ms) {
			return new Date(ms + 8 * 3600 * 1e3).toISOString().slice(0, 10);
		}
		/** 今天往前 n 天的北京日历日键。 */
		function shiftDayKey(days) {
			return beijingDayKey(Date.now() - days * 864e5);
		}
		/** 柱状图横轴标签抽稀步长。 */
		function labelStep(count) {
			if (count > 60) return 14;
			if (count > 30) return 7;
			if (count > 14) return 2;
			return 1;
		}
		/** 面板组件：容器 + 命令式 DOM（避免为图表引入 react 生态依赖）。 */
		function UsagePage() {
			const hostRef = react.useRef(null);
			react.useEffect(() => {
				const root = hostRef.current;
				if (root === null) return;
				let range = 14;
				let selectedDate = null;
				let pieMode = "tokens";
				/** 图例开关：按维度分别记忆被隐藏的 key。 */
				const hidden = /* @__PURE__ */ new Map();
				/** 已加载的按天明细。 */
				const details = /* @__PURE__ */ new Map();
				let detailsKey = "";
				let lastDetailAt = 0;
				let detailError = "";
				let summary = null;
				let disposed = false;
				let pollTimer = 0;
				const style = el("style");
				style.textContent = STYLES;
				const page = el("div", "dus-page");
				const head = el("div", "dus-head");
				const actions = el("div", "dus-actions");
				const refreshButton = el("button", "dus-btn", "刷新");
				const rescanButton = el("button", "dus-btn", "增量扫描");
				const rebuildButton = el("button", "dus-btn", "重建统计");
				rebuildButton.title = "清空账本并从头重放全部历史（改定价或新增统计维度后用，耗时较长）";
				actions.append(refreshButton, rescanButton, rebuildButton);
				head.append(el("h3", void 0, "用量统计"), actions);
				const status = el("p", "dus-status", "加载中…");
				const warn = el("p", "dus-warn", "");
				warn.style.display = "none";
				const cards = el("div", "dus-cards");
				/** 卡片：标题 + 主值 + 副值。 */
				const makeCard = (label) => {
					const node = el("div", "dus-card");
					const labelNode = el("div", "dus-card-label", label);
					const value = el("div", "dus-card-value", "—");
					const sub = el("div", "dus-card-sub", "");
					node.append(labelNode, value, sub);
					return {
						node,
						label: labelNode,
						value,
						sub
					};
				};
				const cardTokens = makeCard("总 tokens");
				const cardCost = makeCard("估算费用");
				const cardSessions = makeCard("会话 / 轮次");
				const cardTools = makeCard("工具调用");
				cards.append(cardTokens.node, cardCost.node, cardSessions.node, cardTools.node);
				const bucketSection = el("div");
				const bucketTitle = el("div", "dus-section", "token 构成");
				bucketSection.append(bucketTitle);
				const bucketRows = [
					{
						key: "uncachedInputTokens",
						label: "未缓存输入",
						cls: "",
						fill: el("div", "dus-fill"),
						value: el("div", "dus-bucket-value", "0")
					},
					{
						key: "cacheReadTokens",
						label: "缓存读取",
						cls: "hit",
						fill: el("div", "dus-fill hit"),
						value: el("div", "dus-bucket-value", "0")
					},
					{
						key: "cacheWriteTokens",
						label: "缓存写入",
						cls: "write",
						fill: el("div", "dus-fill write"),
						value: el("div", "dus-bucket-value", "0")
					},
					{
						key: "outputTokens",
						label: "输出",
						cls: "out",
						fill: el("div", "dus-fill out"),
						value: el("div", "dus-bucket-value", "0")
					}
				];
				for (const row of bucketRows) {
					const line = el("div", "dus-bucket");
					const track = el("div", "dus-track");
					track.append(row.fill);
					line.append(el("div", "dus-bucket-label", row.label), track, row.value);
					bucketSection.append(line);
				}
				/** 建一张「标题 + 空态 + 表格」的板块。 */
				const makeTableSection = (title, emptyText, columns) => {
					const section = el("div");
					const titleNode = el("div", "dus-section", title);
					const empty = el("div", "dus-empty", emptyText);
					const table = el("table", "dus-table");
					const thead = el("thead");
					const headRow = el("tr");
					for (const [text, cls] of columns) headRow.append(el("th", cls === "" ? void 0 : cls, text));
					thead.append(headRow);
					const body = el("tbody");
					table.append(thead, body);
					section.append(titleNode, empty, table);
					return {
						section,
						title: titleNode,
						empty,
						table,
						body
					};
				};
				const toolsSection = makeTableSection("工具调用排行", "暂无工具调用记录", [
					["工具", ""],
					["次数", "num"],
					["占比", "share"],
					["总耗时", "num"]
				]);
				const modelsSection = makeTableSection("按模型", "暂无模型调用记录", [
					["模型", ""],
					["调用", "num"],
					["缓存读", "num"],
					["输出", "num"],
					["费用", "num"]
				]);
				const sessionsSection = makeTableSection("最贵的对话", "暂无会话用量记录", [
					["对话", ""],
					["创建", "num"],
					["tokens", "num"],
					["费用", "num"]
				]);
				const trendSection = el("div");
				const trendTitle = el("div", "dus-section", "用量趋势");
				const trendControls = el("div", "dus-row");
				const rangeSeg = el("div", "dus-seg");
				const rangeButtons = /* @__PURE__ */ new Map();
				for (const item of RANGES) {
					const button = el("button", void 0, item.label);
					button.addEventListener("click", () => {
						if (range === item.key) return;
						range = item.key;
						selectedDate = null;
						details.clear();
						detailsKey = "";
						paintRangeButtons();
						loadDetails(true).then(() => paint());
						loadSummary();
					});
					rangeButtons.set(item.key, button);
					rangeSeg.append(button);
				}
				const chip = el("div", "dus-chip");
				const chipLabel = el("span", void 0, "");
				const chipClear = el("button", void 0, "×");
				chipClear.title = "取消选择，回到累计视图";
				chipClear.addEventListener("click", () => {
					selectedDate = null;
					paint();
				});
				chip.append(chipLabel, chipClear);
				trendControls.append(rangeSeg, chip);
				const chart = el("div", "dus-chart");
				const axis = el("div", "dus-axis");
				const trendSub = el("div", "dus-card-sub", "");
				trendSection.append(trendTitle, trendControls, chart, axis, trendSub);
				const pieSection = el("div");
				const pieTitle = el("div", "dus-section", "构成分析");
				const pieControls = el("div", "dus-row");
				const modeSeg = el("div", "dus-seg");
				const modeButtons = /* @__PURE__ */ new Map();
				for (const item of MODES) {
					const button = el("button", void 0, item.label);
					button.addEventListener("click", () => {
						if (pieMode === item.key) return;
						pieMode = item.key;
						paintPie();
					});
					modeButtons.set(item.key, button);
					modeSeg.append(button);
				}
				pieControls.append(modeSeg);
				const pieFlex = el("div", "dus-pie-flex");
				const pieChart = el("div");
				const legend = el("ul", "dus-legend");
				pieFlex.append(pieChart, legend);
				const pieSub = el("div", "dus-pie-sub2", "");
				pieSection.append(pieTitle, pieControls, pieFlex, pieSub);
				page.append(style, head, status, warn, cards, bucketSection, toolsSection.section, modelsSection.section, sessionsSection.section, trendSection, pieSection);
				root.append(page);
				const bars = createBars(chart, axis, (key) => {
					selectedDate = selectedDate === key ? null : key;
					paint();
				});
				const donut = createDonut(pieChart, (slice) => {
					if (slice === null) {
						paintPieCenter();
						return;
					}
					const total = currentSlices().reduce((sum, item) => sum + Math.max(0, item.value), 0);
					donut.setCenter(slice.label, `${fmtPercent(total > 0 ? slice.value / total : 0)} · ${sliceDetailText(slice, total)}`);
				});
				const summaryUrl = () => `${API}/summary?${range === "all" ? "range=all" : `days=${range}`}&top=${TOP}`;
				const detailRangeKey = () => {
					const to = beijingDayKey(Date.now());
					if (range === "all") return `${summary?.days[0]?.date ?? to}..${to}`;
					return `${shiftDayKey(range - 1)}..${to}`;
				};
				const loadSummary = async () => {
					try {
						const response = await fetch(summaryUrl(), {
							headers: { accept: "application/json" },
							credentials: "same-origin"
						});
						if (response.status === 401 || response.status === 403) {
							status.textContent = `插件接口拒绝了本次请求（HTTP ${response.status}）：请从带 token 的地址打开 DSH 并刷新页面。`;
							return;
						}
						const data = await response.json();
						if (disposed) return;
						if (data.ok !== true) {
							status.textContent = "统计数据不可用";
							return;
						}
						summary = data;
						if (selectedDate !== null && !data.days.some((day) => day.date === selectedDate)) selectedDate = null;
						paint();
					} catch (error) {
						if (!disposed) status.textContent = `加载失败：${String(error)}`;
					}
				};
				const loadDetails = async (force) => {
					const key = detailRangeKey();
					if (!force && key === detailsKey && Date.now() - lastDetailAt < DETAIL_TTL_MS) return;
					const [from, to] = key.split("..");
					try {
						const response = await fetch(`${API}/days?from=${from}&to=${to}`, {
							headers: { accept: "application/json" },
							credentials: "same-origin"
						});
						if (response.status === 401 || response.status === 403) {
							detailError = `接口拒绝（HTTP ${response.status}）：请刷新页面重新登录`;
							return;
						}
						const data = await response.json();
						if (disposed) return;
						if (data.ok !== true) {
							detailError = "明细接口返回异常";
							return;
						}
						details.clear();
						for (const day of data.days ?? []) details.set(day.date, day);
						detailsKey = key;
						lastDetailAt = Date.now();
						detailError = "";
					} catch (error) {
						detailError = String(error);
					}
				};
				/** 当前视角覆盖的日期集合：选中单日，或当前窗口内有数据的全部日期。 */
				const scopeDates = () => {
					if (selectedDate !== null) return [selectedDate];
					return (summary?.days ?? []).map((day) => day.date);
				};
				/** 当前视角的用量合计。 */
				const scopeUsage = () => {
					if (selectedDate === null) {
						const totals = summary?.totals;
						return {
							usage: totals ?? emptyUsage(),
							toolCalls: totals?.toolCalls ?? 0,
							modelCalls: 0,
							turns: totals?.turns ?? 0,
							steps: totals?.steps ?? 0,
							sessions: totals?.sessions ?? 0
						};
					}
					const day = summary?.days.find((item) => item.date === selectedDate);
					const usage = emptyUsage();
					if (day !== void 0) addUsage(usage, day);
					return {
						usage,
						toolCalls: day?.toolCalls ?? 0,
						modelCalls: day?.modelCalls ?? 0,
						turns: 0,
						steps: 0,
						sessions: details.get(selectedDate)?.sessions.length ?? 0
					};
				};
				/** 聚合当前视角的模型 / 工具 / 会话。 */
				const aggregate = (kind) => {
					const map = /* @__PURE__ */ new Map();
					for (const date of scopeDates()) {
						const detail = details.get(date);
						if (detail === void 0) continue;
						if (kind === "models") for (const item of detail.models) {
							const cur = map.get(item.model) ?? {
								key: item.model,
								label: item.model,
								usage: emptyUsage(),
								calls: 0,
								ms: 0
							};
							addUsage(cur.usage, item);
							cur.calls += item.calls;
							map.set(item.model, cur);
						}
						else if (kind === "tools") for (const item of detail.tools) {
							const cur = map.get(item.name) ?? {
								key: item.name,
								label: item.name,
								usage: emptyUsage(),
								calls: 0,
								ms: 0
							};
							cur.calls += item.calls;
							cur.ms += item.ms;
							map.set(item.name, cur);
						}
						else for (const item of detail.sessions) {
							const label = item.title !== null && item.title !== "" ? item.title : item.id.slice(0, 12);
							const cur = map.get(item.id) ?? {
								key: item.id,
								label,
								usage: emptyUsage(),
								calls: 0,
								ms: 0
							};
							addUsage(cur.usage, item.usage);
							cur.calls += 1;
							map.set(item.id, cur);
						}
					}
					const list = [...map.values()];
					if (kind === "tools") list.sort((left, right) => right.calls - left.calls || right.ms - left.ms);
					else list.sort((left, right) => right.usage.costCny - left.usage.costCny);
					return list;
				};
				/** 把聚合项切成饼图切片（含「其他」归并）与图例。 */
				const toSlices = (items, kind) => {
					const valueOf = (item) => kind === "tools" ? item.calls : item.usage.costCny;
					const top = kind === "tools" ? PIE_TOP_TOOLS : PIE_TOP_SESSIONS;
					const head = items.slice(0, kind === "models" ? items.length : top);
					const rest = items.slice(head.length);
					const slices = head.map((item, index) => ({
						key: item.key,
						label: item.label,
						value: valueOf(item),
						color: paletteColor(index),
						detail: kind === "tools" ? fmtDuration(item.ms) : fmtCost(item.usage.costCny)
					}));
					if (rest.length > 0) {
						const value = rest.reduce((sum, item) => sum + valueOf(item), 0);
						const ms = rest.reduce((sum, item) => sum + item.ms, 0);
						slices.push({
							key: "__other__",
							label: `其他 ${rest.length} 项`,
							value,
							color: OTHER_COLOR,
							detail: kind === "tools" ? fmtDuration(ms) : fmtCost(rest.reduce((sum, item) => sum + item.usage.costCny, 0))
						});
					}
					return slices.filter((slice) => slice.value > 0);
				};
				/** 当前维度的完整切片（含被图例隐藏的项，供环心占比计算）。 */
				const allSlices = () => {
					if (pieMode === "tokens") {
						const usage = scopeUsage().usage;
						return [
							{
								key: "uncachedInputTokens",
								label: "未缓存输入",
								value: usage.uncachedInputTokens,
								color: BUCKET_COLORS.uncachedInputTokens
							},
							{
								key: "cacheReadTokens",
								label: "缓存读取",
								value: usage.cacheReadTokens,
								color: BUCKET_COLORS.cacheReadTokens
							},
							{
								key: "cacheWriteTokens",
								label: "缓存写入",
								value: usage.cacheWriteTokens,
								color: BUCKET_COLORS.cacheWriteTokens
							},
							{
								key: "outputTokens",
								label: "输出（含思维链）",
								value: usage.outputTokens,
								color: BUCKET_COLORS.outputTokens
							}
						].filter((slice) => slice.value > 0);
					}
					return toSlices(aggregate(pieMode), pieMode);
				};
				/** 应用图例开关后的切片（真正参与绘制）。 */
				const currentSlices = () => {
					const off = hidden.get(pieMode);
					if (off === void 0 || off.size === 0) return allSlices();
					return allSlices().filter((slice) => !off.has(slice.key));
				};
				/** 扇区副文本（按维度换单位）。 */
				const sliceDetailText = (slice, total) => {
					if (pieMode === "tools") return `${fmtInt(slice.value)} 次${slice.detail !== void 0 ? ` · ${slice.detail}` : ""}`;
					if (pieMode === "tokens") return fmtTokens(slice.value);
					return `${fmtCost(slice.value)}${slice.detail !== void 0 ? ` · ${slice.detail}` : ""}`;
				};
				const paintRangeButtons = () => {
					for (const [key, button] of rangeButtons) button.classList.toggle("on", key === range);
					for (const [key, button] of modeButtons) button.classList.toggle("on", key === pieMode);
					chip.style.display = selectedDate === null ? "none" : "inline-flex";
					chipLabel.textContent = selectedDate ?? "";
				};
				const scopeLabel = () => selectedDate !== null ? selectedDate : range === "all" ? "全部时间" : `近 ${range} 天`;
				const paintCards = () => {
					const scope = scopeUsage();
					const tokens = usageTokens(scope.usage);
					cardTokens.value.textContent = fmtTokens(tokens);
					cardTokens.value.title = `${fmtInt(tokens)} tokens`;
					cardTokens.sub.textContent = selectedDate === null ? `未缓存 ${fmtTokens(scope.usage.uncachedInputTokens)} · 缓存读 ${fmtTokens(scope.usage.cacheReadTokens)}` : `模型调用 ${fmtInt(scope.modelCalls)} 次`;
					cardCost.value.textContent = fmtCost(scope.usage.costCny);
					cardCost.value.title = `¥${scope.usage.costCny}`;
					cardCost.sub.textContent = "按峰谷时段估算，以账单为准";
					cardSessions.value.textContent = selectedDate === null ? `${fmtInt(scope.sessions)} / ${fmtInt(scope.turns)}` : `${fmtInt(scope.sessions)} 个对话`;
					cardSessions.sub.textContent = selectedDate === null ? `步数 ${fmtInt(scope.steps)}` : "当日参与的对话数";
					cardTools.value.textContent = fmtInt(scope.toolCalls);
					cardTools.sub.textContent = selectedDate === null ? `${fmtInt(summary?.toolKinds ?? 0)} 种工具` : "当日工具调用";
					for (const card of [
						cardTokens,
						cardCost,
						cardSessions,
						cardTools
					]) card.label.title = scopeLabel();
				};
				const paintBuckets = () => {
					const usage = scopeUsage().usage;
					const total = usageTokens(usage);
					const peak = Math.max(usage.uncachedInputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.outputTokens, 1);
					bucketTitle.textContent = `token 构成 · ${scopeLabel()}`;
					for (const row of bucketRows) {
						const value = usage[row.key];
						row.fill.style.width = `${Math.max(value > 0 ? 1.5 : 0, value / peak * 100)}%`;
						row.value.textContent = `${fmtTokens(value)} (${fmtPercent(total > 0 ? value / total : 0)})`;
						row.value.title = fmtInt(value);
					}
				};
				const paintTools = () => {
					const detail = selectedDate !== null ? details.get(selectedDate) : void 0;
					const rows = selectedDate !== null ? (detail?.tools ?? []).slice(0, TOP).map((item) => {
						const totalCalls = (detail?.tools ?? []).reduce((sum, tool) => sum + tool.calls, 0);
						return {
							name: item.name,
							calls: item.calls,
							ms: item.ms,
							share: totalCalls > 0 ? item.calls / totalCalls : 0
						};
					}) : summary?.tools ?? [];
					toolsSection.title.textContent = `工具调用排行 · ${scopeLabel()}`;
					toolsSection.body.textContent = "";
					if (rows.length === 0) {
						toolsSection.empty.style.display = "block";
						toolsSection.table.style.display = "none";
						return;
					}
					toolsSection.empty.style.display = "none";
					toolsSection.table.style.display = "table";
					for (const tool of rows) {
						const tr = el("tr");
						const name = el("td", "name", tool.name);
						name.title = tool.name;
						const calls = el("td", "num", fmtInt(tool.calls));
						const shareCell = el("td", "share");
						const mini = el("div", "dus-mini");
						mini.style.width = `${Math.max(2, Math.round(tool.share * 100))}%`;
						shareCell.append(mini);
						const ms = el("td", "num", fmtDuration(tool.ms));
						ms.title = `${fmtInt(tool.ms)} ms`;
						tr.append(name, calls, shareCell, ms);
						toolsSection.body.append(tr);
					}
				};
				const paintModels = () => {
					const detail = selectedDate !== null ? details.get(selectedDate) : void 0;
					const rows = selectedDate !== null ? [...detail?.models ?? []].sort((left, right) => right.costCny - left.costCny) : summary?.models ?? [];
					modelsSection.title.textContent = `按模型 · ${scopeLabel()}`;
					modelsSection.body.textContent = "";
					if (rows.length === 0) {
						modelsSection.empty.style.display = "block";
						modelsSection.table.style.display = "none";
						return;
					}
					modelsSection.empty.style.display = "none";
					modelsSection.table.style.display = "table";
					for (const row of rows) {
						const tr = el("tr");
						const name = el("td", "name", row.model);
						name.title = row.model;
						const calls = el("td", "num", fmtInt(row.calls));
						const cacheRead = el("td", "num", fmtTokens(row.cacheReadTokens));
						cacheRead.title = `${fmtInt(row.cacheReadTokens)} 缓存读取`;
						const output = el("td", "num", fmtTokens(row.outputTokens));
						output.title = `${fmtInt(row.outputTokens)} 输出`;
						const cost = el("td", "num", fmtCost(row.costCny));
						cost.title = `¥${row.costCny}`;
						tr.append(name, calls, cacheRead, output, cost);
						modelsSection.body.append(tr);
					}
				};
				const paintSessions = () => {
					const detail = selectedDate !== null ? details.get(selectedDate) : void 0;
					sessionsSection.title.textContent = `最贵的对话 · ${scopeLabel()}`;
					sessionsSection.body.textContent = "";
					const rows = selectedDate !== null ? [...detail?.sessions ?? []].sort((left, right) => right.usage.costCny - left.usage.costCny).map((item) => ({
						label: item.title !== null && item.title !== "" ? item.title : item.id.slice(0, 12),
						tip: [
							item.title ?? "(无标题)",
							item.id,
							item.origin === "subagent" ? "子代理会话" : "主会话"
						].join("\n"),
						createdAt: 0,
						tokens: usageTokens(item.usage),
						cost: item.usage.costCny
					})) : (summary?.sessions ?? []).map((row) => ({
						label: row.title !== null && row.title !== "" ? row.title : `${row.cwd.split(/[\\/]/).pop() ?? ""} / ${row.id.slice(0, 8)}`,
						tip: [
							row.title ?? "(无标题)",
							row.id,
							row.cwd,
							`${row.origin === "subagent" ? "子代理会话" : "主会话"} · 模型调用 ${fmtInt(row.modelCalls)} 次 · 工具 ${fmtInt(row.toolCalls)} 次`
						].join("\n"),
						createdAt: row.createdAt,
						tokens: usageTokens(row.usage),
						cost: row.usage.costCny
					}));
					if (rows.length === 0) {
						sessionsSection.empty.style.display = "block";
						sessionsSection.table.style.display = "none";
						return;
					}
					sessionsSection.empty.style.display = "none";
					sessionsSection.table.style.display = "table";
					for (const row of rows) {
						const tr = el("tr");
						const name = el("td", "name", row.label);
						name.title = row.tip;
						const when = el("td", "num", row.createdAt > 0 ? fmtDateTime(row.createdAt).slice(0, 10) : "—");
						const tokens = el("td", "num", fmtTokens(row.tokens));
						tokens.title = fmtInt(row.tokens);
						const cost = el("td", "num", fmtCost(row.cost));
						cost.title = `¥${row.cost}`;
						tr.append(name, when, tokens, cost);
						sessionsSection.body.append(tr);
					}
				};
				const paintTrend = () => {
					const days = summary?.days ?? [];
					const todayKey = beijingDayKey(Date.now());
					const barsData = days.map((day) => {
						const tokens = usageTokens(day);
						return {
							key: day.date,
							value: tokens,
							today: day.date === todayKey,
							tooltip: `${day.date}\n${fmtInt(tokens)} tokens（${fmtTokens(tokens)}）\n${fmtCost(day.costCny)} · 工具 ${fmtInt(day.toolCalls)} 次 · 模型 ${fmtInt(day.modelCalls)} 次\n点击查看当天明细`
						};
					});
					bars.update(barsData, selectedDate, labelStep(days.length));
					const sum = days.reduce((acc, day) => acc + usageTokens(day), 0);
					const cost = days.reduce((acc, day) => acc + day.costCny, 0);
					trendTitle.textContent = `用量趋势 · ${range === "all" ? "全部时间" : `近 ${range} 天`}（点柱子选中某天，再点取消）`;
					trendSub.textContent = `窗口合计 ${fmtInt(sum)} tokens（${fmtTokens(sum)}） · ${fmtCost(cost)}`;
				};
				const paintPie = () => {
					const slices = currentSlices();
					const off = hidden.get(pieMode);
					for (const [key, button] of modeButtons) button.classList.toggle("on", key === pieMode);
					pieTitle.textContent = `构成分析 · ${scopeLabel()}`;
					pieSub.textContent = pieMode === "tokens" ? "按四桶拆分（互斥计数：billed input = 未缓存 + 缓存读 + 缓存写）" : pieMode === "models" ? "按估算费用降序；点图例可隐藏某一项" : pieMode === "tools" ? `按调用次数降序，取前 ${PIE_TOP_TOOLS} 项，其余归入「其他」` : `按费用降序，取前 ${PIE_TOP_SESSIONS} 个对话，其余归入「其他」`;
					donut.update(slices, pieMode === "tokens" ? "合计" : "当前视角", fmtTokens(slices.reduce((sum, slice) => sum + slice.value, 0)));
					paintPieCenter();
					legend.textContent = "";
					if (slices.length === 0) {
						const loading = detailError === "" && details.size === 0;
						legend.append(el("li", "dus-empty", loading ? "明细加载中…" : "当前视角暂无数据"));
						return;
					}
					for (const slice of slices) {
						const item = el("li", off?.has(slice.key) === true ? "off" : void 0);
						const swatch = el("span", "sw");
						swatch.style.background = slice.color;
						const name = el("span", "nm", slice.label);
						name.title = slice.label;
						const value = pieMode === "tools" ? `${fmtInt(slice.value)} 次` : pieMode === "tokens" ? fmtTokens(slice.value) : fmtCost(slice.value);
						const valueNode = el("span", "vl", value);
						item.append(swatch, name, valueNode);
						item.title = `${slice.label}\n${value}${slice.detail !== void 0 ? ` · ${slice.detail}` : ""}`;
						item.addEventListener("click", () => {
							const set = hidden.get(pieMode) ?? /* @__PURE__ */ new Set();
							if (set.has(slice.key)) set.delete(slice.key);
							else set.add(slice.key);
							hidden.set(pieMode, set);
							paintPie();
						});
						legend.append(item);
					}
				};
				/** 环心默认文本（hover 时由回调临时覆盖）。 */
				const paintPieCenter = () => {
					const total = currentSlices().reduce((sum, slice) => sum + slice.value, 0);
					const label = pieMode === "tokens" ? "tokens 合计" : pieMode === "tools" ? "调用合计" : "费用合计";
					const value = pieMode === "tools" ? `${fmtInt(total)} 次` : pieMode === "tokens" ? fmtTokens(total) : fmtCost(total);
					donut.setCenter(label, value);
				};
				const paintStatus = () => {
					const meta = summary?.meta;
					const backfill = summary?.backfill;
					const progress = backfill === void 0 ? "" : backfill.running ? ` · 回填中 ${fmtInt(backfill.scanned)}/${fmtInt(backfill.total)}` : backfill.done ? ` · 已回填 ${fmtInt(backfill.scanned)}/${fmtInt(backfill.total)}` : "";
					const time = summary === null ? "" : ` · 更新于 ${new Date(summary.generatedAt).toLocaleTimeString("zh-CN", { hour12: false })}`;
					status.textContent = `${meta?.persistenceAvailable === true ? "持久化服务可用" : "持久化服务不可用（仅统计本次启动）"}${progress}${time}`;
					status.title = meta === void 0 ? "" : [`账本：${meta.ledgerFile}`, typeof meta.priceOverrides === "number" && meta.priceOverrides > 0 ? `单价覆盖：${meta.priceFile}（${meta.priceOverrides} 条生效）` : `单价表：内置${typeof meta.priceFile === "string" ? `（可用 ${meta.priceFile} 覆盖）` : ""}`].join("\n");
					const messages = [];
					const hints = [];
					if (meta?.persistenceAvailable === false) messages.push("未找到会话持久化服务，历史回填不可用。");
					if (meta !== void 0 && meta.writeError !== null) messages.push(`账本写入失败（统计仅在内存中）：${meta.writeError}`);
					if (backfill !== void 0 && backfill.errors > 0) messages.push(`${backfill.errors} 个会话读取失败，已跳过。`);
					if (detailError !== "") messages.push(`按天明细刷新失败：${detailError}`);
					if (meta?.detailMissing === true) {
						messages.push("按天明细缺失（升级后新增维度，历史不会自动补算）。");
						hints.push("点「重建统计」补全");
					}
					if (typeof meta?.priceFileError === "string") {
						messages.push(`单价覆盖文件不可用（已改用内置价表）：${meta.priceFileError}`);
						hints.push(`检查 ${meta.priceFile}`);
					}
					const unpriced = Array.isArray(meta?.unpricedModels) ? meta.unpricedModels : [];
					if (unpriced.length > 0) {
						const shown = unpriced.slice(0, 4).join(" / ");
						messages.push(`费用仅供参考：${unpriced.length} 个模型未收录价表，按基价兜底（${shown}${unpriced.length > 4 ? " 等" : ""}）。`);
						hints.push(`在 ${meta?.priceFile ?? "单价覆盖文件"} 里补单价后点「重建统计」`);
					}
					warn.textContent = [messages.join(" "), hints.length > 0 ? `—— ${hints.join("；")}。` : ""].join("").trim();
					warn.style.display = messages.length > 0 ? "block" : "none";
				};
				/** 全量重绘（数据或交互状态变化时调用）。 */
				const paint = () => {
					if (summary === null) return;
					paintRangeButtons();
					paintCards();
					paintBuckets();
					paintTools();
					paintModels();
					paintSessions();
					paintTrend();
					paintPie();
					paintStatus();
				};
				const scan = (button, label, rebuild) => {
					button.disabled = true;
					button.textContent = "扫描中…";
					fetch(`${API}/rescan${rebuild ? "?rebuild=1" : ""}`, {
						method: "POST",
						credentials: "same-origin"
					}).then((response) => {
						if (response.status === 401 || response.status === 403) throw new Error(`接口拒绝（HTTP ${response.status}）：请刷新页面重新登录`);
						return response.json();
					}).then(() => {
						if (rebuild) {
							details.clear();
							detailsKey = "";
							selectedDate = null;
						}
						return loadSummary().then(() => loadDetails(true)).then(() => paint());
					}).catch((error) => {
						status.textContent = `扫描失败：${String(error)}`;
					}).finally(() => {
						button.disabled = false;
						button.textContent = label;
					});
				};
				refreshButton.addEventListener("click", () => {
					loadSummary().then(() => loadDetails(true)).then(() => paint());
				});
				rescanButton.addEventListener("click", () => scan(rescanButton, "增量扫描", false));
				rebuildButton.addEventListener("click", () => scan(rebuildButton, "重建统计", true));
				loadSummary().then(() => loadDetails(true)).then(() => paint());
				pollTimer = window.setInterval(() => {
					loadSummary().then(() => loadDetails(false)).then(() => paint());
				}, POLL_MS);
				return () => {
					disposed = true;
					if (pollTimer !== 0) window.clearInterval(pollTimer);
					bars.dispose();
					donut.dispose();
				};
			}, []);
			return react.createElement("div", { ref: hostRef });
		}
		/**
		* 注册设置页分区。
		* @param ctx - client 上下文（含 slots 服务）。
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "usage-stats",
				order: 50,
				label: () => "用量统计"
			}, () => react.createElement(UsagePage))), "usage-stats: settings page");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map