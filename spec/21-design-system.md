# 21. Design system

The console has one look in three themes. It must be rebuilt so that someone who knows today's console sees the same product: flat, dense, monochrome in Light and Dark, and a starry night with one purple accent in Dusk.

## 21.1 Principles

1. **Flat.** No shadows anywhere: not on menus, dialogs, toasts, the Agent's message box, cards or popovers. Separation comes from 1px lines.
2. **Small corners.** Every box, control, bubble, chip, toast and error uses a 6px radius ("rounded-md", 0.375rem). Only things that are meant to be round stay round: status dots, spinner rings, avatars, stars and the moon. No pills, no large radii. The one exception is listed in 21.5 (two Agent home elements in Dusk use 8px).
3. **Compact controls.** Buttons, inputs, selects, link-buttons, chips, bubbles, toasts and inline errors use 4px vertical and 8px horizontal padding ("px-2 py-1", 0.25rem by 0.5rem) and 12px text. Icon-only buttons may be square with no padding.
4. **Dense text.** Body copy inside dashboard pages is 12px on a 16px line. Headings keep their own sizes.
5. **One accent at most.** Light and Dark are black, white and greys. Dusk adds one purple. No other hues except status colors (success green, running blue or amber, failure red) and the destructive red.
6. **Nothing grays out while loading.** The page being left stays at full brightness until the next one is ready (see 21.7).
7. **Every URL gets Copy and Visit.** Wherever the console shows a service address, a Copy button and a Visit button (opens in a new tab) sit beside it.

## 21.2 Themes

| Behavior | Rule |
| --- | --- |
| Choices | Light, Dark, Dusk. |
| Where | The user menu shows a three-way radio group with a sun (Light), a moon (Dark) and a sunset (Dusk) icon. The chosen option is highlighted; in Dusk the highlight is purple. |
| Default | Anyone who has never picked a theme gets **Light** (owner's decision, 2026-11-27; Dusk and Dark stay one click away in the user menu). |
| Storage | The choice is kept in the browser, per browser. It is not part of the account. |
| No flash | The theme is applied before the first paint of every page, including pages swapped in by in-app navigation. |
| Public pages | Sign-in, registration, invitation, password and onboarding pages use the same theme as the dashboard: this browser's saved choice, else Light. The theme never changes between signing in, onboarding and the dashboard (owner's decision, 2026-11-27). |
| Layering | Dusk is built on Dark: every page that renders correctly in Dark must render correctly in Dusk, and Dusk only refines it. Terminals, charts and code editors treat Dark and Dusk as dark. |
| Fonts | Fonts used only by Dusk (serif and mono, see 21.4) load only when Dusk is active. |

**Acceptance**
- A new browser opens the dashboard in Light with no flash of another theme.
- Picking Dusk, reloading and navigating between pages keeps Dusk; a second browser still opens in Light.
- A new browser shows sign-in, onboarding and the dashboard all in Light. After picking Dusk, the sign-in page is Dusk too. Signing in never changes the theme.
- A sweep of every dashboard route in Dark and in Dusk finds no large light surface and no text below a 2.6:1 contrast ratio.

## 21.3 Color tokens

Token names below are the 1.0 names; values are exact.

| Token | Light | Dark | Dusk |
| --- | --- | --- | --- |
| `page` (behind everything) | #f3f4f6 | #050506 | #050507 |
| `raised` (header, menus, dialogs) | #ffffff | #0a0a0c | #0c0b11 |
| `muted` (quiet fills) | #f7f7f8 | #141416 | #111017 |
| `hover` | #ececef | #1f1f23 | white at 6% |
| `line` | #eceef3 | #1f1f23 | white #fafaf9 at 12% |
| `line-strong` | #e5e7eb | #323238 | white at 20% |
| `card-line` | #eceef3 | #27272a | white at 12% |
| `grid-line` (shell hairlines, background grid) | #eceef3 | #2a2a2e | white at 8% |
| `surface` (content panels) | #ffffff | #0a0a0c | #08080b |
| `text` | #111827 | #fafafa | #fafaf9 |
| `text-dim` | #6b7280 | #a1a1aa | white at 66% |
| `text-faint` | #9ca3af | #71717a | white at 42% |
| `primary` (main button fill) | #111827 | #fafafa | #7c3aed |
| `primary-text` | #ffffff | #18181b | #ffffff |
| `primary-hover` | #1f2937 | #e4e4e7 | #8b5cf6 |
| `composer` (Agent message box) | #ffffff | #18181b | rgba(10,10,12,0.82) |
| `code` (code block fill) | #f3f4f6 | #27272a | #13121a |
| `danger` | hsl(0 84% 50%) | hsl(0 84% 50%) | hsl(0 84% 50%) |

Dusk-only tokens:

| Token | Value |
| --- | --- |
| `accent` | #7c3aed |
| `accent-deep` | #6d28d9 |
| `accent-light` | #8b5cf6 |
| `accent-soft` (purple text on dark) | #a78bfa |
| `accent-tint` (active item fill) | rgba(124,58,237,0.16) |
| `glass` (sidebars, panels) | rgba(9,9,12,0.62) with 12px background blur |
| `cell` (grid cells) | rgba(9,9,12,0.88) |
| `focus` | rgba(167,139,250,0.6) |
| `selection` | rgba(124,58,237,0.4) with white text |
| `moonlight` | a 1px line, transparent → rgba(196,181,253,0.75) → transparent |

## 21.4 Typography

| Use | Light and Dark | Dusk |
| --- | --- | --- |
| Interface text | Geist (variable), falling back to the system UI stack | Geist, antialiased |
| Code, terminals, logs | System monospace | Geist Mono (variable) |
| Small print: sidebar section labels, uppercase eyebrows (DOMAIN, STATUS), session times, composer hint, live timers | Interface font | Geist Mono 11px; uppercase labels tracked 0.08 to 0.1em, sidebar labels in `text-faint` |
| Page titles | Interface font, bold | Instrument Serif regular, 26px, weight 400, tracking -0.01em, line height 1.1 |
| Agent greeting (empty chat) | Interface font, two lines | Instrument Serif, fluid 42px to 84px, line height 0.95, centered; the second line in `accent-soft` italics |

Rule: serif only for big headlines. Body and small text stay in Geist.

## 21.5 Components

**Buttons**
- All: 12px text, 4px by 8px padding, 6px corners, pointer cursor, 1px border.
- Primary in Light: `primary` fill with white text; Dark: near-white fill with dark text.
- Primary in Dusk is a **pixel button**: a vertical gradient from `accent-light` to `accent-deep`, overlaid with a 3px grid of fine dots (0.75px white dots at 16%), a 1px border of white at 16%, white text. Hover shifts the gradient lighter.
- Pixel glow (Dusk only): while the pointer is over a primary or outlined button, the dots within 30px of the pointer light up; a click sends a ripple out from the click point over 650ms. The glow is drawn as an overlay above the button and never changes the button's own markup. It also works on buttons inside open dialogs. It is off when the person asks for reduced motion and does no work when nothing is hovered.
- Outlined (ghost) buttons in Dusk: border white at 18%, fill white at 4% with a faint purple dot texture; the border warms to purple on hover.
- The Agent's send button stays purple but dimmed to 50% until there is something to send.
- Disabled buttons are visibly dimmed and take no clicks.

**Fields**: 1px `line` border, 6px corners, 4px by 8px padding, 12px text. Focus shows a visible ring; in Dusk the border and ring turn `focus` purple. Text areas size by their row count.

**Menus, popovers, dialogs**: `raised` fill, 1px `line` border, no shadow. In Dusk, dialogs and the user menu carry the `moonlight` line across the middle 72% of their top edge. Dialogs close on Escape and on a click on the backdrop, but never because their own content was re-rendered under the pointer.

**Toasts**: bottom right, up to 28rem wide (full width minus 2rem on phones), 1px border, no shadow.

**Navigation highlight**: the current sidebar item, tab and project menu item get a `hover`-strength fill in Light and Dark; in Dusk they get `accent-tint` with `accent-soft` text.

**Status pills**: small, 6px corners, a colored dot plus a word (for example Building, Active, Failed). Dark and Dusk have their own legible variants.

**Tables**: flat, hairline row separators, no elevation. On narrow screens wide tables scroll inside their own box and never widen the page.

**Icons**: line icons, 2px stroke, round caps and joins, 16px in navigation.

**Agent home in Dusk**
- The moon: a 60px to 120px disc near the top right (5% from the top, 4% from the right), lit from the upper left (#f4f0ff to lavender, fading out), with a soft purple glow; it floats 12px up and down over 9 seconds.
- The sunrise: a wide purple glow rising from below the bottom center (up to 1100px wide and 62% of the chat's height).
- Both show only while the chat is empty.
- The message box: `composer` glass with 10px blur, 8px corners, the `moonlight` line along its top, and a purple border on focus.
- The four starters sit in one grid split by 1px hairlines, 8px outer corners. Each cell shows an icon tile and text, with its number (01 to 04) in mono at the right. On hover the number becomes an arrow (→), the cell takes a light purple tint, and the icon tile fills with the purple gradient.
- The person's question bubbles: purple at 12% with a hairline border. The Agent's mark is `accent-soft`.

## 21.6 Shell layout

- **Header row**: 42px tall, sticky, `raised` at 92% opacity with a light blur. Left: the phone menu button (below 1024px only), the organization switcher, then breadcrumbs for project and environment (with an environment switcher and a PRODUCTION badge on production). Right: the notifications bell.
- **Panels**: in Light and Dark the header, sidebar and content are separated by 1px hairlines in `grid-line`. Behind the shell a faint grid of `grid-line` lines is drawn, with cells from 160px to 250px wide and 104px to 176px tall, scaling with the window.
- **Dusk shell**: the grid is hidden. A star field covers the whole dashboard: 110 stars at fixed positions (the same sky on every page and every visit), 84% of them 1px and the rest 2px, white, each twinkling between 15% and 80% opacity over 5 seconds with a staggered start of up to 5 seconds. Panels are `glass` over the sky and separated by hairline borders. The header is black at 55% with a 12px blur and a bottom hairline. Stars stop twinkling and the moon stops floating under reduced motion.
- **Sidebar on ordinary pages** (Projects, Deployments, Tasks, Analytics, Servers, Domains, Settings): 17rem (272px) wide from 1024px up. Order: Agent, Projects, Deployments, Tasks, Analytics, then an "Infrastructure" group with Servers and Domains, then Documentation (https://nearzero.dev/docs) and Support (mailto:support@nearzero.dev) links, both opening outside the console, with the user menu at the bottom (it opens upward). Items the person has no permission for are hidden.
- **Agent page and a project's pages**: a narrow icon rail plus an expandable primary sidebar, and a secondary column (the Agent's sessions, or the project's own menu). The primary sidebar starts open on the Agent page and stays exactly as the person left it: once they open or close it, that choice holds on every page with the rail, across visits, until they change it. It is rendered in that state on the first paint (no flicker). With no saved choice a project's pages start with it collapsed so the canvas gets the width.
- **Settings**: a settings sidebar of its own inside the content area (see the settings spec).
- **User menu**: the person's name and email, the theme picker, Settings, Documentation, Support and Log out.

## 21.7 Motion and loading

- In-app navigation swaps page content without a full reload.
- While the next page loads, the current page stays exactly as it is, takes no clicks, and a 2px bar runs along the top of the window (to 85% over 2.4 seconds, then fills and fades). In Dusk the bar is a purple gradient; otherwise it is the `text` color.
- New content fades in over 180ms with a 4px rise.
- Loading placeholders stay invisible for their first 150ms, so fast pages never flash a spinner.
- Hovering, pressing or focusing a link starts fetching that page's data; a prefetched result is used once, lives 15 seconds, and is dropped after any change the person makes.
- A page that fails to load in 25 seconds shows a retry control instead of spinning forever.
- **Interface motion** (owner's request, 2026-11-27). Motion is short and quiet: transform and opacity only, ease-out, never a shadow, and never anything running while idle.
  - **Sidebar**: collapsing and expanding the primary sidebar (and the icon rail's expand) animates its width over 200ms. Its labels fade out first and back in last, and the content beside it follows smoothly with no jump. The Agent's sessions column and a project's menu column do the same when they open or close.
  - **Phone navigation sheet** and the Agent's sessions slide-over slide in from their edge over 220ms while the blur behind them fades in. Closing reverses it over 180ms.
  - **Menus and popovers** (user menu, workspace switcher, row menus, selects' lists, environment switcher): fade in with a 4px drop from their button over 140ms, and fade out over 100ms.
  - **Dialogs and sheets**: the backdrop fades over 160ms, and the panel fades in while scaling from 98% over 180ms. Closing takes 120ms.
  - **Toasts**: rise 8px and fade in over 180ms, and fade out over 140ms.
  - **Expandable parts** (the Agent's steps and folded results, collapsible sections, settings groups): open and close by animating their height over 180ms.
  - **Tabs**: the active tab's underline or highlight slides to the new tab over 180ms.
  - **Hover, press and focus**: color, background and border changes ease over 120ms. Pressing a button nudges it to 98% while held.
  - Every animation can be interrupted: reopening mid-close never jumps, and fast repeated clicks never queue up animations.
- Under reduced motion, every animation above is off (content just appears).
- **Acceptance**: a test reads the computed transition and animation durations of the sidebar, the navigation sheet, a menu, a dialog, a toast, an Agent step and a tab strip, finds the durations above, and finds 0 for all of them under reduced motion. The sweep finds no console error and no shadow while any of them is mid-animation.

## 21.8 Phone layout

Breakpoints: below 1024px is "tablet and phone", below 640px is "phone".

Below 1024px:
- No sidebar and no icon rail. The header's menu button opens one navigation sheet holding every link. It closes when the person navigates, including in-app navigation.
- A project's own menu (Overview, Services, Variables and so on) becomes one row of tabs above the content.
- Settings navigation becomes a sideways-scrolling row of links, with the current one scrolled into view.

Below 720px: the Agent's sessions list slides over the chat instead of sitting beside it, opened by a history icon.

Below 640px:
- The header never overflows a 375px screen. The brand name is hidden, the workspace name is capped (about 5.5rem when project crumbs show, 11rem otherwise), crumb names are capped at about 6.5rem with an ellipsis, and the PRODUCTION badge is hidden.
- The project canvas stacks: each service card full width, its domain card under it indented by 1rem; no connecting lines and no dragging, so a swipe scrolls the page.
- Toolbars that hold tabs and action buttons (a service page, Domains, Servers, Analytics) wrap: tabs on one line, buttons on the next.
- List pages (Projects, Tasks, Servers, Deployments): the search gets its own row, and the filters share the next row in equal widths. The main action button sits beside the page title.
- Menus open inside the screen (anchored so they never spill off the left or right edge).
- DNS records read as three lines: name, then type and value, then the copy buttons.

**Acceptance**: an automated sweep of every dashboard route at 375px, 390px, 768px and 1024px widths finds no horizontal page scroll, no clipped header, and no control narrower than its label.

## 21.9 Plain-HTTP constraints

A fresh install serves the console over plain HTTP on an IP address until a domain is set. Browsers treat that as an insecure context and hide some APIs. The console must work fully there.

| Not available on plain HTTP | Requirement |
| --- | --- |
| Random UUID generation in the browser | Generate IDs from the browser's random-bytes API, which is always available. |
| The browser's subtle crypto API | Never hash, sign or encrypt in the browser. Do it on the server. |
| The asynchronous clipboard API | Copy buttons try the clipboard API first, then fall back to selecting a hidden read-only text field and copying it. The fallback field must be placed inside an open modal dialog when one is open, because the rest of the page is inert. Copy only runs from a real click. If both fail, show "The browser refused to copy." |

Other rules:
- Session cookies are marked Secure only when the console is served over HTTPS. The same per-request rule holds for every cookie the console sets itself: the invitation link (its token and emailed proof), the "already shown this invitation" mark and flash messages (31a G1-13). Once a domain is set, the plain IP address redirects to the HTTPS address, because a Secure cookie cannot be set over HTTP.
- Sign-in, sign-up and invitation forms submit with POST. On load, the page removes any `password` or `code` value from its address bar, in case a submit happened before the page's script loaded.
- Automated tests run the console in a simulated insecure context (these three APIs removed) and fail on any direct use.

**Acceptance**: on a server reached at `http://<ip>:4321`, every Copy button works, every form that creates something works, and nothing logs an error about a missing browser API.

## 21.9b Brand files, tab icon and page metadata (owner's decision, 2026-11-27)

The Nearzero mark is the owner-supplied brand kit, kept in the repository as the console's public icon files: `favicon.svg`, `icon.svg` and `logo.svg` (a 3×3 dot grid on a dark rounded square), and `og.png` (1200×630). Use these files as they are. Never draw a substitute mark.

- **Tab icon on every page**, public pages included:
  - `<link rel="icon">` points at the mark's SVG;
  - `/favicon.ico` (16 and 32 px, made from the mark);
  - `/apple-touch-icon.png` (180 px, on an opaque background);
  - a web manifest (`/manifest.webmanifest`: name "Nearzero", 192 and 512 px PNG icons, background and theme colors from the Light tokens) linked from every page;
  - `<meta name="theme-color">` set to the current theme's `page` token, updated when the theme changes.
  - Every icon URL answers 200 with the right content type, through the router and directly on port 4321.
- **The mark in the interface**: wherever the shell or a public page shows the brand (sidebar and phone header brand, sign-in and onboarding headers if they show one, the Agent's mark when idle if it uses the brand), it is this mark, sized as the layout says.
- **Link previews**: public pages (sign-in, invitation acceptance, registration) carry `og:title`, `og:description` and `og:image` (`/og.png`, absolute URL from the console's address), plus `twitter:card` = `summary_large_image`. Dashboard pages carry none.
- **Titles and description**: every page's title is "<Page> · Nearzero" ("Nearzero" alone on the home), and every page has a one-sentence `<meta name="description">`.
- **Robots**: `/robots.txt` answers `User-agent: *` / `Disallow: /`, and every page carries `<meta name="robots" content="noindex, nofollow">`. A self-hosted console is never indexed.
- **Error pages**: 404 and 500 pages use the shell's theme and the mark, and give a way back ("Go to your projects", or "Sign in" when signed out).
- **Acceptance**: the sweep checks, on every page, the icon links, the manifest link, the title format, the description, robots meta and theme-color. A test fetches every icon URL and `/robots.txt` and checks status and content type.

## 21.9a Control padding wins over the visual reference (owner's decision, 2026-11-27)

Principle 3 (compact controls) applies everywhere. Where 21.10's visual reference shows larger controls, this rule wins.

- It covers every text field, password field, search box, select, text area, button and link styled as a button, on every page. That includes sign-in, registration, invitation acceptance, onboarding, every dialog and sheet, menus' trigger buttons, toolbars, tables, settings and the Agent (its message box included). Each one has exactly **4px vertical and 8px horizontal padding** (`px-2 py-1`).
- No height or minimum height may make a control taller than its padding, line height and 1px border give.
- Exceptions: icon-only buttons (square, no padding, per principle 3), and checkboxes, radio buttons, switches and sliders.
- Also allowed:
  - A select may have more right padding, to hold its drawn chevron.
  - The collapsed sidebar's user button shows only the avatar, so it counts as icon-only.
  - A text area that grows with its text is as tall as its lines.
  - Color and file inputs are left out.
- Corners: every one of those controls has **6px corners** (`rounded-md`, 0.375rem) in every theme. No pill, circle or larger radius. Icon-only buttons too, unless they are status dots, which stay round.
- **No shadows**, as principle 1 says. No control, and no other element on any page, has a box shadow or drop-shadow filter in any theme or state (hover, focus, active, open). Focus is shown with an outline ring, not a shadow. Dusk's pixel glow and sunrise stay, because they are overlays and gradients, not shadows.
- Text sizes, colors and borders stay as they are.
- **Acceptance**: the console sweep reads the computed padding of every visible control on every page, in every theme and width, and fails on any control outside the exceptions that isn't 4px 8px, doesn't have 6px corners, or has a fixed or minimum height above its natural one. It also fails on any element with a box shadow or drop-shadow filter, in any state it can reach (hover and focus included).

## 21.10 Visual reference correction (2026-11-26)

A side-by-side capture of every 0.1.79 page against 1.0 showed where the sections above describe the look wrongly or loosely. **The look to rebuild is the 0.1.79 console as captured in the visual reference set** (screenshots of every page in Light, Dark and Dusk at 1440×900 and 390×844, with a page-by-page difference list and measured values). Where this section or the reference set disagrees with 21.1 to 21.9, they win. The main corrections:

- **Surfaces**: the content area, sidebars, project menu, settings menu and title strips are opaque (Light #ffffff, Dark #0a0a0c, Dusk #08080b). No page grid shows in the dashboard in any theme; in Dusk the stars show only on the Agent home and through the header (#0c0b11 at 92% with a 12px blur and a white 12% bottom hairline). Cards in Dusk are #0c0b11; footer and code strips #111017 (Dark #141416).
- **Fonts**: Light and Dark use the system UI stack for interface text, **Space Grotesk** for the brand, list, service and settings titles, the Agent greeting and the "Account" heading, and **IBM Plex Mono** for code, keys, container names, URLs and app names (all self-hosted). Dusk uses Geist, Geist Mono and Instrument Serif page titles as in 21.4, but service names stay Space Grotesk 600 14px.
- **Page structure**: list and settings pages are hairline-separated strips: a 42px title strip (service pages 48px; settings 65px with a 16px Space Grotesk title), a full-width toolbar strip whose search field grows to fill the row (no magnifier) with filters on the right, and a footer pinned to the bottom with "N total" and Previous/Next.
- **Sidebar**: 272px, items 28px tall with 6px gaps, 12px/20px weight 400 (active 500), icon 16px with 12px before the label; no Documentation or Support links (they stay in the user menu), no top toggle, no separators; collapses with a 20px round button on its right edge. User button: 28px rounded-square avatar with initials, name, email, chevron.
- **Project pages**: a 52px icon rail and a 272px project menu with only **Overview** and **Services** (the shared Variables page opens from a service's Variables tab, "Edit shared"). The Compose page and the new-application page show the rail only.
- **Components**: buttons are text only (no leading icons); outlined buttons have a transparent fill and a #eceef3 border; table row actions are plain grey text buttons; a few secondary actions are filled grey and Compose Stop is filled red. Fields are grey-filled (#f7f7f8) in forms. Table headers are filled #f7f7f8, 32px, with an "Actions" header. Members & access uses underline tabs with counts. Empty states are plain centred text (no icon tile, no dashed box). Avatars are rounded squares, never purple circles. Uppercase labels are 12px weight 500 with 0.6px tracking.
- **Times**: tables and service pages show calendar times ("Today, 8:23 PM"); the bell shows full dates; Projects cards and SSH keys show relative times.
- **Wording**: 1.0 uses the original's words where this spec had renamed them: Organization(s) in the switcher and its dialogs, "Traefik" for the router files page, "Error" on deployment pills, "Create Server", "Add Notification", "External port", "Scheduled backups", "Restore…", "Open Terminal" on database pages, "My Account" heading, "Create" on dialog submits, and the original's database type names (Postgres, Mysql, Mongo, Mariadb, LibSQL).
- **Phone**: header with menu button and full crumbs (no brand, no truncation); the navigation sheet is 232px, has no header or close button and no Documentation/Support, and blurs (not darkens) the page; service pages show project tabs, then the back strip, the service tabs, then the action row; the Agent home has a 34px row with icon-only history and new-session buttons, a left-aligned greeting with the box under it and the starters below; phone tables drop less important columns instead of scrolling.
- **Features 1.0 adds stay, drawn in the original's style** (owner's decision, 2026-11-26): the app Logs and Advanced (ports and mounts) tabs; the database Logs tab; Deployments, Domains and Delete sections on the Compose page; service and server tasks with a "Runs on" column on Tasks; host, monitoring and alert cards on About Nearzero; image and data-volume rows on database Settings; Router files editing. Visual comparisons treat these as intended, not as differences.
