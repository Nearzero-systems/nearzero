import type { Page } from "playwright";

/**
 * The checks of spec 21.9a (and, in `metadataProblems` below, 21.9b), shared by every sweep.
 *
 * `controlProblems` runs inside a page (pass it to page.evaluate; it uses nothing from outside
 * itself). Every visible text field, password field, search box, select, text area, button and
 * link styled as a button must have 4px by 8px padding and 6px corners, and no height or minimum
 * height may make it taller than its padding, line height and border give. No element, and none
 * of their ::before and ::after boxes, may have a box shadow or a drop-shadow filter: checked at
 * rest, with focus on each control, and in every style rule the page loaded (which covers hover,
 * active and open states too). `hoverProblems` adds the pointer over each button.
 *
 * - Buttons are the design system's `.nz-btn` (buttons and links), submit inputs, menus' trigger
 *   buttons (`aria-haspopup`, `popovertarget`) and the other bordered button styles (chips, the
 *   new-application provider buttons, the deploy log's failure button).
 * - Exceptions (21.9a): icon-only buttons have no padding or height rule (their corners are
 *   still 6px); checkboxes, radio buttons, switches and sliders are left out.
 * - Listed exception: a select keeps room for its chevron on the right (its right padding may be
 *   larger than 8px); its other sides are 4px and 8px like every field.
 * - With `dialogs`, every closed dialog on the page is opened for a moment and checked too.
 * - `unchecked` names the other clickable things seen (tabs, menu items, rows, plain text
 *   buttons), so a report can say what the rule left out.
 */

export const BUTTONS =
  '.nz-btn, input[type="submit"], input[type="button"], input[type="reset"], button[aria-haspopup], a[aria-haspopup], button[popovertarget], .nz-chip, .nz-newapp-provider-btn, .nz-log-failure';

export function controlProblems(options: { dialogs: boolean }): {
  problems: string[];
  shadows: string[];
  shadowRules: string[];
  unchecked: string[];
} {
  const FIELDS =
    'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="hidden"]):not([type="file"]):not([type="color"]):not([type="image"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea';
  const BUTTON_SELECTOR =
    '.nz-btn, input[type="submit"], input[type="button"], input[type="reset"], button[aria-haspopup], a[aria-haspopup], button[popovertarget], .nz-chip, .nz-newapp-provider-btn, .nz-log-failure';
  const CLICKABLE = 'button, a[role="button"], [role="button"]';
  const EXEMPT_ROLES = new Set(["switch", "checkbox", "radio", "slider"]);
  const problems: string[] = [];
  const shadows = new Set<string>();
  const unchecked = new Set<string>();

  const visible = (el: Element) => {
    const box = el.getBoundingClientRect();
    return (
      el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
      box.width > 1 &&
      box.height > 1 &&
      !el.closest(".nz-visually-hidden")
    );
  };
  /**
   * Text a person sees in it: text inside a box clipped to a pixel (screen-reader labels, a
   * collapsed sidebar's names) doesn't count, nor, with `avatars`, an avatar's initials.
   */
  const shownText = (el: Element, avatars = false) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      if (!text) continue;
      let shown = true;
      for (let box = node.parentElement; box; box = box.parentElement) {
        const rect = box.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1 || (avatars && box.matches(".nz-avatar"))) {
          shown = false;
          break;
        }
        if (box === el) break;
      }
      if (shown) parts.push(text);
    }
    return parts.join(" ");
  };
  const describe = (el: Element) => {
    const text = shownText(el).replace(/\s+/g, " ").slice(0, 30);
    const cls =
      typeof el.className === "string"
        ? el.className.split(" ").filter(Boolean).slice(0, 3).join(".")
        : "";
    const label = el.getAttribute("aria-label") ?? el.getAttribute("name") ?? "";
    return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}>${text ? ` "${text}"` : label ? ` [${label}]` : ""}`;
  };
  /** Icon-only buttons, an avatar alone (the collapsed sidebar's user button) counting as one. */
  const iconOnly = (el: Element) =>
    el.matches(".nz-btn--icon") ||
    (shownText(el, true) === "" && el.querySelector("svg, img, .nz-avatar") !== null);
  const outOfScope = (el: Element) => {
    const role = el.getAttribute("role");
    return role !== null && EXEMPT_ROLES.has(role);
  };
  /** The height with no height, minimum height or stretching applied (a text area's lines). */
  const natural = (el: HTMLElement) => {
    const saved = el.getAttribute("style");
    el.style.setProperty("height", "auto", "important");
    el.style.setProperty("min-height", "0", "important");
    el.style.setProperty("align-self", "flex-start", "important");
    let height = el.getBoundingClientRect().height;
    // A text area that grows with its text (the Agent's message box) is as tall as its lines.
    if (el.tagName === "TEXTAREA") {
      const style = getComputedStyle(el);
      const borders =
        Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
      height = Math.max(height, el.scrollHeight + borders);
    }
    if (saved === null) el.removeAttribute("style");
    else el.setAttribute("style", saved);
    return height;
  };
  const near = (value: string, wanted: number) =>
    Math.abs(Number.parseFloat(value) - wanted) < 0.05;
  /** A box shadow or a drop-shadow filter on the element or its ::before / ::after. */
  const shadowOf = (el: Element): string | null => {
    for (const pseudo of [null, "::before", "::after"]) {
      const style = getComputedStyle(el, pseudo);
      if (pseudo && (style.content === "none" || style.content === "normal")) continue;
      if (style.boxShadow && style.boxShadow !== "none") {
        return `${pseudo ?? ""} box-shadow ${style.boxShadow}`.trim();
      }
      if (style.filter.includes("drop-shadow")) {
        return `${pseudo ?? ""} filter ${style.filter}`.trim();
      }
    }
    return null;
  };
  const noteShadow = (el: Element, state: string, where: string) => {
    const shadow = shadowOf(el);
    if (shadow) shadows.add(`${state}${shadow}: ${describe(el)}${where}`);
  };

  const checkIn = (root: ParentNode, where: string) => {
    const controls = new Set<Element>([
      ...root.querySelectorAll(FIELDS),
      ...root.querySelectorAll(BUTTON_SELECTOR),
    ]);
    for (const el of controls) {
      if (!visible(el) || outOfScope(el)) continue;
      const style = getComputedStyle(el);
      const corners = [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ];
      if (!corners.every((corner) => near(corner, 6))) {
        problems.push(`corners ${corners.join(" ")}, not 6px: ${describe(el)}${where}`);
      }
      if (el.matches("button, a, [role='button'], input") && iconOnly(el)) continue;
      const select = el.tagName === "SELECT";
      const sides = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];
      const padded =
        near(style.paddingTop, 4) &&
        near(style.paddingBottom, 4) &&
        near(style.paddingLeft, 8) &&
        (select ? Number.parseFloat(style.paddingRight) >= 7.95 : near(style.paddingRight, 8));
      if (!padded) {
        problems.push(`padding ${sides.join(" ")}, not 4px 8px: ${describe(el)}${where}`);
      }
      const height = el.getBoundingClientRect().height;
      const own = natural(el as HTMLElement);
      if (height > own + 0.5) {
        problems.push(
          `${Math.round(height * 10) / 10}px tall, ${Math.round(own * 10) / 10}px without its height or minimum height: ${describe(el)}${where}`,
        );
      }
    }
    for (const el of root.querySelectorAll(CLICKABLE)) {
      if (controls.has(el) || !visible(el) || outOfScope(el) || iconOnly(el)) continue;
      const cls =
        typeof el.className === "string" ? (el.className.split(" ").filter(Boolean)[0] ?? "") : "";
      const role = el.getAttribute("role");
      unchecked.add(`${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${role ? `[${role}]` : ""}`);
    }
    // No shadows at rest, on anything.
    for (const el of root.querySelectorAll("*")) {
      if (visible(el)) noteShadow(el, "", where);
    }
    // Nor with focus on a control (its own ring, or a ring its container draws around it).
    const active = document.activeElement as HTMLElement | null;
    for (const el of controls) {
      if (!visible(el) || !(el instanceof HTMLElement)) continue;
      el.focus({ preventScroll: true });
      if (document.activeElement !== el) continue;
      for (
        let node: Element | null = el;
        node && node !== document.body;
        node = node.parentElement
      ) {
        noteShadow(node, "focused: ", where);
      }
      el.blur();
    }
    active?.focus?.({ preventScroll: true });
  };

  checkIn(document, "");
  if (options.dialogs) {
    for (const dialog of Array.from(document.querySelectorAll("dialog"))) {
      if (dialog.open) continue;
      // Without its opening motion (spec 21.7), so it is checked as it rests, not while it is
      // still transparent and scaled.
      dialog.setAttribute("data-motion-pause", "");
      try {
        dialog.show();
      } catch {
        dialog.removeAttribute("data-motion-pause");
        continue;
      }
      checkIn(dialog, ` (in #${dialog.id || "dialog"})`);
      dialog.close();
      dialog.removeAttribute("data-motion-pause");
    }
  }

  // Every style rule the page loaded, whatever state it is for (:hover, :focus, [open]…). A
  // library's rule that a later rule for the same selector sets back to `none` is fine.
  const shadowRules = new Set<string>();
  const found: { order: number; selectors: string[]; text: string }[] = [];
  const cleared: { order: number; selector: string }[] = [];
  let order = 0;
  const written = (style: CSSStyleDeclaration, name: string) => {
    const value = style.getPropertyValue(name).trim();
    return value !== "" && value !== "none" && value !== "0 0 #0000" && value !== "initial";
  };
  const scan = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      order++;
      if (rule instanceof CSSStyleRule) {
        const style = rule.style;
        const selectors = rule.selectorText.split(",").map((part) => part.trim());
        const box = style.getPropertyValue("box-shadow").trim();
        if (box === "none") {
          for (const selector of selectors) cleared.push({ order, selector });
        }
        // Tailwind's shadow, ring and filter utilities read variables that stay empty unless a
        // shadow utility sets them, so only a shadow actually written counts.
        const shadow =
          (box !== "" && box !== "none" && !box.startsWith("var(--tw-")) ||
          written(style, "--tw-shadow") ||
          written(style, "--tw-inset-shadow") ||
          written(style, "--tw-drop-shadow") ||
          style.getPropertyValue("filter").includes("drop-shadow(");
        if (shadow) {
          found.push({
            order,
            selectors,
            text: `${rule.selectorText} { ${style.cssText.slice(0, 160)} }`,
          });
        }
      }
      const inner = (rule as CSSGroupingRule).cssRules;
      if (inner) scan(inner);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      scan(sheet.cssRules);
    } catch {
      // A stylesheet from another origin can't be read; the console loads none.
    }
  }
  for (const rule of found) {
    const undone = rule.selectors.every((selector) =>
      cleared.some((item) => item.order > rule.order && item.selector === selector),
    );
    if (!undone) shadowRules.add(rule.text);
  }
  return {
    problems: [...new Set(problems)],
    shadows: [...shadows],
    shadowRules: [...shadowRules].sort(),
    unchecked: [...unchecked].sort(),
  };
}

/** A box shadow or drop-shadow filter on the element, its pseudo boxes or its containers. */
function shadowNearby(el: Element): string | null {
  for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
    for (const pseudo of [null, "::before", "::after"]) {
      const style = getComputedStyle(node, pseudo);
      if (pseudo && (style.content === "none" || style.content === "normal")) continue;
      const name = `${node.tagName.toLowerCase()}.${String(node.className).split(" ")[0]}${pseudo ?? ""}`;
      if (style.boxShadow && style.boxShadow !== "none") {
        return `${name} box-shadow ${style.boxShadow}`;
      }
      if (style.filter.includes("drop-shadow")) return `${name} filter ${style.filter}`;
    }
  }
  return null;
}

/**
 * Moves the pointer over each visible button on the screen (no clicks) and reports any shadow it
 * brings up on the button or around it.
 */
export async function hoverProblems(page: Page): Promise<string[]> {
  const problems = new Set<string>();
  const viewport = page.viewportSize();
  if (!viewport) return [];
  for (const button of (await page.$$(BUTTONS)).slice(0, 80)) {
    const box = await button.boundingBox().catch(() => null);
    if (!box || box.width < 2 || box.height < 2) continue;
    if (box.y < 0 || box.x < 0 || box.y + box.height > viewport.height) continue;
    if (box.x + box.width > viewport.width) continue;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const found = await button.evaluate(shadowNearby).catch(() => null);
    if (found) {
      const name = await button
        .evaluate(
          (el) => `<${el.tagName.toLowerCase()}> "${(el.textContent ?? "").trim().slice(0, 30)}"`,
        )
        .catch(() => "a button");
      problems.add(`hovered ${name}: ${found}`);
    }
  }
  await page.mouse.move(0, 0);
  return [...problems];
}

/**
 * The checks of spec 21.9b on one page. Like `controlProblems`, it runs inside the page (pass it
 * to page.evaluate) and uses nothing from outside itself:
 * - the title is "<Page> · Nearzero", or "Nearzero" alone on the home (`home`);
 * - one one-sentence description, and robots "noindex, nofollow";
 * - the icon links (the mark's SVG, favicon.ico, the touch icon) and one manifest link;
 * - one theme-color, equal to the current theme's `page` token as the page's CSS computes it;
 * - link previews on public pages only (`preview`): og:title, og:description, an absolute
 *   og:image at this console's own address, and twitter:card summary_large_image;
 * - the mark wherever the brand shows (the header's brand, the error pages) has loaded, and with
 *   `mark` the page must show it (the 404 and 500 pages).
 */
export function metadataProblems(args: {
  home: boolean;
  preview: boolean;
  mark?: boolean;
}): string[] {
  const problems: string[] = [];
  const metas = (key: string) =>
    Array.from(
      document.head.querySelectorAll<HTMLMetaElement>(
        `meta[name="${key}"], meta[property="${key}"]`,
      ),
    );
  const one = (key: string) => {
    const found = metas(key);
    if (found.length !== 1) {
      problems.push(`${found.length} <meta ${key}> tags, expected one`);
      return null;
    }
    return found[0]?.content ?? "";
  };

  const title = document.title;
  if (args.home) {
    if (title !== "Nearzero") problems.push(`title "${title}", expected "Nearzero" on the home`);
  } else if (!/^\S.* · Nearzero$/.test(title) || title === "Nearzero · Nearzero") {
    problems.push(`title "${title}" isn't "<Page> · Nearzero"`);
  }

  const description = one("description");
  if (description !== null) {
    const sentence = description.trim();
    if (!/^[A-Z].*\.$/s.test(sentence) || /[.!?]\s+\S/.test(sentence) || sentence.length > 200) {
      problems.push(`description isn't one sentence: "${sentence}"`);
    }
  }
  const robots = one("robots");
  if (robots !== null && robots !== "noindex, nofollow") {
    problems.push(`robots meta "${robots}", expected "noindex, nofollow"`);
  }

  const links = Array.from(document.head.querySelectorAll<HTMLLinkElement>("link[rel]"));
  const has = (rel: string, href: string, type?: string) =>
    links.some(
      (link) =>
        link.rel === rel &&
        link.getAttribute("href") === href &&
        (type === undefined || link.type === type),
    );
  if (!has("icon", "/favicon.svg", "image/svg+xml")) problems.push("no SVG icon link");
  if (!has("icon", "/favicon.ico")) problems.push("no favicon.ico link");
  if (!has("apple-touch-icon", "/apple-touch-icon.png")) problems.push("no touch icon link");
  const manifests = links.filter((link) => link.rel === "manifest");
  if (manifests.length !== 1 || manifests[0]?.getAttribute("href") !== "/manifest.webmanifest") {
    problems.push(`${manifests.length} manifest links, expected one to /manifest.webmanifest`);
  }

  const themeColor = one("theme-color");
  const page = getComputedStyle(document.documentElement).getPropertyValue("--nz-page").trim();
  if (themeColor !== null && themeColor.toLowerCase() !== page.toLowerCase()) {
    problems.push(
      `theme-color ${themeColor} isn't the ${document.documentElement.dataset.theme} page token ${page}`,
    );
  }

  const previews = Array.from(
    document.head.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]'),
  );
  if (args.preview) {
    for (const key of ["og:title", "og:description", "og:image", "twitter:card"]) {
      if (!one(key)) problems.push(`no ${key} on a public page`);
    }
    const image = metas("og:image")[0]?.content ?? "";
    if (image !== `${location.origin}/og.png`) {
      problems.push(`og:image "${image}" isn't ${location.origin}/og.png`);
    }
    const card = metas("twitter:card")[0]?.content;
    if (card !== "summary_large_image") problems.push(`twitter:card "${card}"`);
  } else if (previews.length > 0) {
    problems.push(`link-preview tags on a page that isn't public (${previews.length})`);
  }

  let marks = 0;
  for (const img of Array.from(
    document.querySelectorAll<HTMLImageElement>(".nz-brand img, img.nz-gate-mark"),
  )) {
    const shown = img.checkVisibility() && img.getBoundingClientRect().width > 0;
    if (!/\/(logo|icon)\.svg$/.test(img.src)) problems.push(`the brand shows ${img.src}`);
    else if (shown && !(img.complete && img.naturalWidth > 0)) {
      problems.push(`the mark ${img.src} didn't load`);
    } else if (shown) marks++;
  }
  if (args.mark && marks === 0) problems.push("no mark on the page");
  return problems;
}
