import { iconSvg } from "../lib/icons.ts";

/**
 * A DNS record shown for copying (spec 9.5, 10.3, 10.5, 10.6): name, then type and value, then
 * Copy name and Copy value. On phones the three parts stack as three lines (operations.css).
 */
export function recordRow(record: {
  type: string;
  name: string;
  value: string | null;
}): HTMLElement {
  const row = document.createElement("div");
  row.className = "nz-record-line";
  const name = document.createElement("span");
  name.className = "nz-record-name nz-code";
  name.textContent = record.name;
  const typeValue = document.createElement("span");
  typeValue.className = "nz-record-tv nz-code";
  typeValue.textContent = `${record.type} ${record.value ?? "(server address unknown)"}`;
  const tools = document.createElement("span");
  tools.className = "nz-record-tools";
  for (const [label, text] of [
    ["Copy name", record.name],
    ["Copy value", record.value ?? ""],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nz-btn nz-btn--outline";
    button.dataset.copy = text;
    button.disabled = !text;
    button.innerHTML = iconSvg("copy");
    button.append(label);
    tools.append(button);
  }
  row.append(name, typeValue, tools);
  return row;
}
