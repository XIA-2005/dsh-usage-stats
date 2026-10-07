/**
 * 面板样式表。
 *
 * 全部使用 DSH 主题变量（`--theme-*`）并带回退色，因此在浅色/深色主题下都自洽。
 *
 * @module @dsh-external/dsh-usage-stats/client/styles
 */

/** 面板 CSS（由 panel 注入到 shadow-free 的 `<style>` 元素）。 */
export const STYLES = `
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
`

/** 饼图/图例调色板（12 色，深浅主题下都可辨识）。 */
export const PALETTE: readonly string[] = [
  '#4a9eff',
  '#2ecc71',
  '#e67e22',
  '#9b59b6',
  '#e84393',
  '#00b8d4',
  '#f1c40f',
  '#7f8c8d',
  '#ff7675',
  '#55efc4',
  '#a29bfe',
  '#fab1a0',
]

/**
 * 取调色板颜色（按索引循环）。
 * @param index - 序号。
 * @returns 十六进制颜色。
 */
export function paletteColor(index: number): string {
  return PALETTE[index % PALETTE.length] ?? '#4a9eff'
}
