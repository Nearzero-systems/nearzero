/**
 * Line charts (spec 13.2 "Requests per hour", 14.2 "CPU history", "RAM history"): drawn on the
 * server for Analytics and in the browser for monitoring, from the same function. The lines are
 * an SVG that stretches to the box (strokes keep their width); the axis labels are HTML, so they
 * stay readable at phone width. Colors come from the theme's tokens through classes, so Light,
 * Dark and Dusk each look right. client/charts.ts adds the crosshair that follows the pointer or
 * the arrow keys.
 */

export interface ChartSeries {
  label: string;
  values: number[];
  /** "accent" (purple), "danger" (red) or "muted" (gray). */
  tone: "accent" | "danger" | "muted";
}

export interface ChartSpec {
  /** One timestamp (ms) per point. */
  xs: number[];
  series: ChartSeries[];
  unit: "count" | "percent";
  /** How times read: by the hour, by the day, or as clock times. */
  xLabel: "hour" | "day" | "time";
}

const W = 1000;
const H = 100;

function escapeText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A round top for the y axis: 1, 2, 4, 5 × 10^n (at least 4); 100 for percentages. */
export function niceMax(value: number, unit: ChartSpec["unit"]): number {
  if (unit === "percent") return 100;
  if (value <= 4) return 4;
  const exponent = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 4, 5, 10]) if (step * exponent >= value) return step * exponent;
  return 10 * exponent;
}

export function timeText(ms: number, kind: ChartSpec["xLabel"]): string {
  const date = new Date(ms);
  if (kind === "day") return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (kind === "hour") {
    // "Nov 25 09:30 PM", as the original's axis reads.
    const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const time = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    return `${day} ${time}`;
  }
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

export function valueText(value: number, unit: ChartSpec["unit"]): string {
  return unit === "percent" ? `${Math.round(value * 10) / 10}%` : String(Math.round(value));
}

/** Which points get an x-axis label: up to six, spread evenly from the first to the last. */
export function chartTicks(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const labels = Math.min(6, count);
  const ticks: number[] = [];
  for (let order = 0; order < labels; order++) {
    const index = Math.round((order * (count - 1)) / (labels - 1));
    if (ticks[ticks.length - 1] !== index) ticks.push(index);
  }
  return ticks;
}

/** The horizontal position (0 to 1) of point `index` of `count`. */
export function positionOf(index: number, count: number): number {
  return count <= 1 ? 0.5 : index / (count - 1);
}

function svg(spec: ChartSpec, max: number): string {
  const count = spec.xs.length;
  const y = (value: number) => H - (Math.min(max, Math.max(0, value)) / max) * H;
  const parts = [0, 0.5].map(
    (fraction) =>
      `<line class="nz-chart-grid" x1="0" x2="${W}" y1="${H * fraction}" y2="${H * fraction}"/>`,
  );
  // The first series is drawn last, so it stays on top where lines meet (Requests over Errors).
  for (const series of [...spec.series].reverse()) {
    if (series.values.length === 0) continue;
    const points = series.values
      .map((value, index) => `${(positionOf(index, count) * W).toFixed(1)},${y(value).toFixed(2)}`)
      .join(" ");
    parts.push(`<polyline class="nz-chart-line nz-chart--${series.tone}" points="${points}"/>`);
  }
  return `<svg class="nz-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${parts.join("")}</svg>`;
}

/** The whole chart as HTML: axes, lines, legend, and the data the crosshair reads. */
export function chartHtml(spec: ChartSpec, label: string): string {
  const max = niceMax(Math.max(0, ...spec.series.flatMap((series) => series.values)), spec.unit);
  const count = spec.xs.length;
  const ticks = chartTicks(count);
  const data = escapeText(
    JSON.stringify({
      xs: spec.xs,
      unit: spec.unit,
      xLabel: spec.xLabel,
      series: spec.series.map((series) => ({
        label: series.label,
        values: series.values,
        tone: series.tone,
      })),
    }),
  );
  const legend = spec.series
    .map(
      (series) =>
        `<span class="nz-chart-key"><span class="nz-chart-swatch nz-chart--${series.tone}"></span>${escapeText(series.label)}</span>`,
    )
    .join("");
  const summary =
    count === 0
      ? "No data yet."
      : `${count} points, highest ${valueText(Math.max(0, ...spec.series.flatMap((series) => series.values)), spec.unit)}.`;
  return [
    `<div class="nz-chart" role="group" tabindex="0" aria-label="${escapeText(`${label}. ${summary} Use the arrow keys to read each point.`)}" data-line-chart="${data}">`,
    `<div class="nz-chart-legend">${legend}</div>`,
    `<div class="nz-chart-body">`,
    `<div class="nz-chart-y" aria-hidden="true"><span>${escapeText(valueText(max, spec.unit))}</span><span>${escapeText(valueText(max / 2, spec.unit))}</span><span>0</span></div>`,
    `<div class="nz-chart-plot">${svg(spec, max)}<span class="nz-chart-cross" hidden></span><span class="nz-chart-tip" role="status" hidden></span></div>`,
    "</div>",
    `<div class="nz-chart-x" aria-hidden="true">${ticks
      .map((index, order) => {
        const align =
          ticks.length === 1
            ? "center"
            : order === 0
              ? "start"
              : order === ticks.length - 1
                ? "end"
                : "center";
        return `<span data-align="${align}">${escapeText(timeText(spec.xs[index] as number, spec.xLabel))}</span>`;
      })
      .join("")}</div>`,
    "</div>",
  ].join("");
}
