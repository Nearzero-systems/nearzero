# Provenance report: M1b, M2b, M3a, M3b

Date: 2026-11-25. Reviewer: provenance reviewer (has read the 0.1.x codebase; did not write code). Same scanner and settings as [M0.md](M0.md): k = 50 tokens, exact and renamed passes, 348 source files scanned.

| Pass | Shared runs of 50+ tokens |
| --- | --- |
| Exact | 0 |
| Renamed | 1, reviewed: a 51-token match between a JSX loop that renders a list of results in the onboarding page and an unrelated list-rendering loop in a 0.1.x demo component. The shared part is only the generic shape `{items.map((item) => (<element class=…><p class=…>{item.field}</p>…` with different elements, fields and purpose. Not a copy. |

Two further builders independently wrote the widely published slug idiom (normalize, strip accents, lowercase, dash chain), which matched 0.1.x token for token. The reviewer asked for one shared helper in the implementers' own single-pass style; all three uses now go through it and the chained form no longer appears anywhere.

Exposure notes: every builder saw the index of the owner's notes in its environment and did not open the notes. One builder's formatter rewrote 17 files of other builders (formatting only); the affected builders re-read them.

Result: pass.
