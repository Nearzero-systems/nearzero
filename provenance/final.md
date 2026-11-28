# Provenance report: everything after M4, through the move to 1.0

Date: 2026-11-27. Reviewer: provenance reviewer (has read the 0.1.x codebase; did not write code). Scanner and settings are the same as in [M0.md](M0.md): k = 50 tokens, exact and renamed passes, over the whole tree at commit 180ca40. That covers 997 source files, with build output under ignored folders left out.

This report covers:
- M5 to M11;
- migration import and its follow-ups;
- punch list passes 1 and 2;
- the visual match with the 0.1.79 reference;
- the full verification pass;
- the four rounds of fixes from the real 0.1.x to 1.0 move test.

| Pass | Shared runs of 50+ tokens |
| --- | --- |
| Exact | 2 places, both reviewed (below) |
| Renamed | 13 places, all reviewed and not copies (below) |

No hits were found in the control plane, the runner's deploy, router, domain or migration code, the installer, or the shared package.

## Wording people see (3 places, 5 runs)

Three runs match sentences shown on the 0.1.79 screens:
- the SSH user hint in Add server;
- the introduction on the Agent policies page;
- the introduction on the Policies tab.

Spec 21.10 makes those screens the look and wording to rebuild. The builders typed the sentences from the reference screenshots, not from code. The markup around each sentence (elements, classes, attributes, field ids) differs. These runs are the copy itself, which the spec asks to keep.

## Shapes the format or the framework dictates (5 places)

- **The runner's .zip reader** (two overlapping runs): reads the central directory's fixed-offset fields. This was already reviewed in [M2c-M3c-M4.md](M2c-M3c-M4.md); the ZIP format fixes those offsets.
- **The Agent's step row in the conversation**: the standard disclosure pattern of a button with `aria-expanded` that toggles a state value, otherwise a plain element. Names, classes and the content under it differ.
- **The session row's state declarations**: a run of `useState` lines.
- **Two tables' header rows** (DNS records; Compose containers): a run of `<th>` cells with common column names.

## Unrelated matches (3 places)

- The settings page's checklist list markup matches the 0.1.x getting-started counter only in a short generic list shape.
- The test zip writer matches an unrelated diagram loop.

## Exposure notes

- Builders saw the index of the owner's notes in their environment and did not open it.
- The visual match builders worked from screenshots and written differences only. The capture tooling, which ran the 0.1.79 app, was kept apart and they didn't read it.
- No builder read 0.1.x code.
- The 0.1.x side of the move (the `nearzero export` command and the move test harness) lives in the 0.1.x repository and was written by a separate builder there. Its findings reached 1.0's builders only as described behavior and runtime facts, such as container and volume names seen on a running host and Compose file names. The spec was amended accordingly (29.5, 29a.9).

Result: pass.
