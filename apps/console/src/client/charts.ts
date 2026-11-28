import { type ChartSpec, positionOf, timeText, valueText } from "../lib/line-chart.ts";

/**
 * The crosshair on every line chart (spec 13.2): it follows the pointer, or the arrow keys when
 * the chart has focus (Home and End jump to the ends), and the tooltip shows each line's value
 * at that point. Charts drawn later (monitoring) work too, since this listens on the document.
 */

function specOf(chart: HTMLElement): ChartSpec | null {
  try {
    return JSON.parse(chart.dataset.lineChart ?? "") as ChartSpec;
  } catch {
    return null;
  }
}

const current = new WeakMap<HTMLElement, number>();

function show(chart: HTMLElement, index: number): void {
  const spec = specOf(chart);
  const cross = chart.querySelector<HTMLElement>(".nz-chart-cross");
  const tip = chart.querySelector<HTMLElement>(".nz-chart-tip");
  if (!spec || !cross || !tip || spec.xs.length === 0) return;
  const at = Math.max(0, Math.min(spec.xs.length - 1, index));
  current.set(chart, at);
  const left = positionOf(at, spec.xs.length) * 100;
  cross.style.left = `${left}%`;
  cross.hidden = false;
  tip.replaceChildren();
  const time = document.createElement("span");
  time.className = "nz-chart-tip-time";
  time.textContent = timeText(spec.xs[at] as number, spec.xLabel === "hour" ? "hour" : spec.xLabel);
  tip.append(time);
  for (const series of spec.series) {
    const row = document.createElement("span");
    row.className = "nz-chart-tip-row";
    const swatch = document.createElement("span");
    swatch.className = `nz-chart-swatch nz-chart--${series.tone}`;
    row.append(swatch, `${series.label}: ${valueText(series.values[at] ?? 0, spec.unit)}`);
    tip.append(row);
  }
  tip.hidden = false;
  tip.dataset.side = left > 60 ? "left" : "right";
  tip.style.left = `${left}%`;
}

function hide(chart: HTMLElement): void {
  const cross = chart.querySelector<HTMLElement>(".nz-chart-cross");
  const tip = chart.querySelector<HTMLElement>(".nz-chart-tip");
  if (cross) cross.hidden = true;
  if (tip) tip.hidden = true;
}

export function initCharts(): void {
  document.addEventListener("pointermove", (event) => {
    const plot = (event.target as Element | null)?.closest?.(".nz-chart-plot");
    const chart = plot?.closest<HTMLElement>("[data-line-chart]");
    if (!plot || !chart) return;
    const spec = specOf(chart);
    if (!spec || spec.xs.length === 0) return;
    const box = plot.getBoundingClientRect();
    const fraction = box.width > 0 ? (event.clientX - box.left) / box.width : 0;
    show(chart, Math.round(fraction * (spec.xs.length - 1)));
  });
  document.addEventListener(
    "pointerleave",
    (event) => {
      const target = event.target as Element | null;
      if (target instanceof HTMLElement && target.matches(".nz-chart-plot")) {
        const chart = target.closest<HTMLElement>("[data-line-chart]");
        if (chart && document.activeElement !== chart) hide(chart);
      }
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    const chart = (event.target as Element | null)?.closest?.<HTMLElement>("[data-line-chart]");
    if (!chart || event.target !== chart) return;
    const spec = specOf(chart);
    if (!spec || spec.xs.length === 0) return;
    const at = current.get(chart) ?? spec.xs.length - 1;
    const step = event.shiftKey ? 10 : 1;
    const next =
      event.key === "ArrowLeft"
        ? at - step
        : event.key === "ArrowRight"
          ? at + step
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? spec.xs.length - 1
              : null;
    if (next === null) {
      if (event.key === "Escape") hide(chart);
      return;
    }
    event.preventDefault();
    show(chart, next);
  });
  document.addEventListener("focusin", (event) => {
    const chart = event.target;
    if (chart instanceof HTMLElement && chart.matches("[data-line-chart]")) {
      const spec = specOf(chart);
      if (spec && spec.xs.length > 0) show(chart, current.get(chart) ?? spec.xs.length - 1);
    }
  });
  document.addEventListener("focusout", (event) => {
    const chart = event.target;
    if (chart instanceof HTMLElement && chart.matches("[data-line-chart]")) hide(chart);
  });
}
