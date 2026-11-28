import { calendarTime, dateTime } from "../lib/time.ts";

/**
 * Times the server rendered in the person's time zone (from the `nz_tz` cookie) are redrawn in
 * the browser's own zone, so a first visit, before the cookie exists, still reads right
 * (spec 21.10: calendar times in tables, full dates in the bell).
 */
function redraw(): void {
  const now = new Date();
  for (const element of document.querySelectorAll<HTMLTimeElement>("time[data-time-format]")) {
    const date = new Date(element.dateTime);
    if (Number.isNaN(date.getTime())) continue;
    const text = element.dataset.timeFormat === "full" ? dateTime(date) : calendarTime(date, now);
    const target = element.querySelector<HTMLElement>("[data-time-text]") ?? element;
    if (target.textContent !== text) target.textContent = text;
  }
}

export function initLocalTimes(): void {
  document.addEventListener("astro:page-load", redraw);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", redraw);
  else redraw();
}
