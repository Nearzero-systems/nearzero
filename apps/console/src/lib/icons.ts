/**
 * The console's line icons (spec 21.5): drawn on a 24px grid with a 2px stroke and round caps and
 * joins. Each entry is the inside of an <svg>; `iconSvg` wraps it for client-side use.
 */

const ICONS = {
  // Navigation (spec 21.10): a dot grid, a square grid, a rocket, a circular arrow, a rising
  // trend line, a cluster of three circles and a globe.
  agent:
    '<g fill="currentColor" stroke="none"><circle cx="4" cy="4" r="2.4"/><circle cx="12" cy="4" r="2.4" opacity=".35"/><circle cx="20" cy="4" r="2.4"/><circle cx="4" cy="12" r="2.4"/><circle cx="12" cy="12" r="2.4"/><circle cx="20" cy="12" r="2.4" opacity=".35"/><circle cx="4" cy="20" r="2.4"/><circle cx="12" cy="20" r="2.4" opacity=".35"/><circle cx="20" cy="20" r="2.4"/></g>',
  projects:
    '<rect x="3" y="3" width="7.5" height="7.5" rx="1.75"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.75"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.75"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.75"/>',
  deployments:
    '<path d="M8 16C9.5 9.5 14 4.5 21 3c-1.5 7-6.5 11.5-13 13z"/><path d="M10.5 10.5 5.5 10 3 13l4.5 2M13.5 13.5l.5 5-3 2.5-2-4.5"/><circle cx="15.5" cy="8.5" r="1.3"/><path d="M5.5 18.5 3 21"/>',
  tasks: '<path d="M21 12a9 9 0 1 1-3.1-6.8"/>',
  analytics: '<path d="M2.5 18 9 11.5l4 4L21 7.5"/><path d="M15.5 7.5H21V13"/>',
  servers:
    '<circle cx="12" cy="7" r="4.25"/><circle cx="7" cy="16" r="4.25"/><circle cx="17" cy="16" r="4.25"/>',
  domains:
    '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.3 2.4 3.5 5.3 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.3-3.5-8.5s1.2-6.1 3.5-8.5z"/>',
  docs: '<path d="M5.5 5.5a2 2 0 0 1 2-2h10v14h-10a2 2 0 0 0-2 2z"/><path d="M5.5 19.5a2 2 0 0 0 2 1h10v-3.5"/>',
  support:
    '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/><path d="M6 6l3.5 3.5M14.5 14.5 18 18M18 6l-3.5 3.5M9.5 14.5 6 18"/>',
  bell: '<path d="M6.5 16.5v-5a5.5 5.5 0 0 1 11 0v5l1.5 2h-14z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  menu: '<path d="M4.5 7h15M4.5 12h15M4.5 17h15"/>',
  "chevron-down": '<path d="M7 10l5 5 5-5"/>',
  "chevron-right": '<path d="M10 7l5 5-5 5"/>',
  "chevron-left": '<path d="M14 7l-5 5 5 5"/>',
  "chevron-up": '<path d="M7 14l5-5 5 5"/>',
  "chevrons-up-down": '<path d="M7.5 9.5 12 5l4.5 4.5M7.5 14.5 12 19l4.5-4.5"/>',
  check: '<path d="M5.5 12.5l4 4 9-9"/>',
  sun: '<circle cx="12" cy="12" r="3.75"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z"/>',
  sunset:
    '<path d="M3.5 17.5h17M8 20.5h8"/><path d="M7.5 17.5a4.5 4.5 0 0 1 9 0"/><path d="M12 6v3.5M6.2 10.7l1.5 1.5M17.8 10.7l-1.5 1.5"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  settings:
    '<path d="M4.5 7.5h9M17.5 7.5h2M4.5 16.5h3M11.5 16.5h8"/><circle cx="15.5" cy="7.5" r="2"/><circle cx="9.5" cy="16.5" r="2"/>',
  logout:
    '<path d="M14.5 4.5h3a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-3"/><path d="M10 8l-4 4 4 4M6 12h9.5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5 19.5 19.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  external:
    '<path d="M13.5 4.5h6v6M19.5 4.5l-8.5 8.5"/><path d="M17.5 13.5v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  history:
    '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9"/><path d="M4.5 4.5V9H9"/><path d="M12 8v4l2.5 2"/>',
  "arrow-up": '<path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5"/>',
  folder:
    '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  "arrow-down": '<path d="M12 5v13.5M6.5 13 12 18.5l5.5-5.5"/>',
  "arrow-right": '<path d="M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5"/>',
  "arrow-left": '<path d="M19 12H5.5M11 6.5 5.5 12l5.5 5.5"/>',
  "eye-off":
    '<path d="M4 4l16 16"/><path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c6 0 9.5 6 9.5 6a16.6 16.6 0 0 1-3 3.6M6.6 7.6A16.4 16.4 0 0 0 2.5 12s3.5 6.5 9.5 6.5a9.5 9.5 0 0 0 4.4-1.1"/><path d="M9.9 10a2.75 2.75 0 0 0 3.9 3.9"/>',
  research: '<circle cx="12" cy="12" r="8.5"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  // A single server: two stacked units with their lights (the Agent's "Set up a server").
  server:
    '<rect x="4" y="4" width="16" height="7" rx="1.75"/><rect x="4" y="13" width="16" height="7" rx="1.75"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  // A painter's palette (Profile: choose the initials' color).
  palette:
    '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.9-.8 1.9-1.8 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8h2.1a4.2 4.2 0 0 0 4.2-4.2c0-3.6-4-6.6-9-6.6z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/>',
  more: '<path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="3"/>',
  database:
    '<ellipse cx="12" cy="6.5" rx="7" ry="3"/><path d="M5 6.5v11c0 1.7 3.1 3 7 3s7-1.3 7-3v-11"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  app: '<path d="M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7z"/><path d="M4.5 7.7 12 12l7.5-4.3M12 12v8.5"/>',
  compose:
    '<path d="M12 4l8.5 4.3L12 12.6 3.5 8.3z"/><path d="M3.5 12.2 12 16.5l8.5-4.3M3.5 16 12 20.3l8.5-4.3"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5h.01"/>',
  git: '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="7.5" r="2"/><path d="M6.5 7.5v9M17.5 9.5c0 3.8-3.6 5.2-9.3 6.5"/>',
  terminal:
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4"/>',
  key: '<circle cx="8" cy="15.5" r="4"/><path d="M11 12.5l8-8M15.5 8l2.5 2.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  sort: '<path d="M7.5 4.5v15M4.5 7.5l3-3 3 3M16.5 19.5v-15M13.5 16.5l3 3 3-3"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5"/>',
  edit: '<path d="M4.5 19.5h4l10-10-4-4-10 10z"/><path d="M13 7l4 4"/>',
  refresh: '<path d="M19.5 11.5a7.5 7.5 0 1 0-2.2 5.8"/><path d="M19.5 5v6.5H13"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M3.5 7.5 12 13l8.5-5.5"/>',
  brand: '<circle cx="12" cy="12" r="8"/><path d="M8.6 15.4 15.4 8.6"/>',
  download:
    '<path d="M12 4.5v10.5M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 16.5v1a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1"/>',
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.75"/>',
  users:
    '<circle cx="9" cy="8.5" r="3.25"/><path d="M3 19.5a6 6 0 0 1 12 0"/><path d="M15.5 5.5a3.25 3.25 0 0 1 0 6.25M17.5 14a6 6 0 0 1 3.5 5.5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function iconInner(name: IconName): string {
  return ICONS[name];
}

export function iconSvg(name: IconName, className = ""): string {
  return `<svg class="${className}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}
