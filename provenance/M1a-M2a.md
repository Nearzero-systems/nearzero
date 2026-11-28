# Provenance report: M1a (identity and access API) and M2a (console design system and shell)

Date: 2026-11-25. Reviewer: provenance reviewer (has read the 0.1.x codebase; did not write code). Same scanner and settings as [M0.md](M0.md): k = 50 tokens, exact and renamed passes, 214 source files scanned.

| Pass | Shared runs of 50+ tokens |
| --- | --- |
| Exact | 0 |
| Renamed | 0 |

One exact run (59 tokens) was found in the first M1a scan: a function turning a name into a web-address slug, written as the widely published normalize → strip accents → lowercase → dash chain. The reviewer judged it a common idiom, not a copy, but asked the implementer to rewrite it in its own structure so published reports show zero runs. The implementer rewrote it without being shown any other code; the rescan is clean.

Exposure notes:
- M1a and M2a builders saw the index of the owner's notes in their environment (titles and one-line summaries, no code) and did not open the notes.
- The M2a builder reported that one command ran in the 0.1.x folder after a failed directory change and printed that folder's top-level file names and some third-party library paths under it. No file was opened. Later briefs require commands to stop when the directory change fails.

Result: pass.
