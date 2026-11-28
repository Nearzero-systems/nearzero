# Provenance report: M2c, M3c, M4

Date: 2026-11-25. Reviewer: provenance reviewer (has read the 0.1.x codebase; did not write code). Same scanner and settings as [M0.md](M0.md): k = 50 tokens, exact and renamed passes, 529 source files scanned.

| Pass | Shared runs of 50+ tokens |
| --- | --- |
| Exact | 0 |
| Renamed | 4, all reviewed and not copies (below) |

Reviewed renamed matches:
- The runner's .zip reader (two overlapping runs): a loop over the central directory reading fixed-offset fields (signature, version, flags, method, CRC). The ZIP file format fixes those offsets, so every correct reader has this shape; the error handling, limits and path checks differ entirely.
- A test helper that writes zip archives, and the onboarding page's results list: generic loop shapes (`for (const item of items)` / `items.map((item) => (<element …>…))`) matching unrelated code.

Earlier in this milestone the scan found one exact run: a single regular expression parsing the certificate authority's "retry after <date> <time>" message, which matched another codebase's expression almost character for character (the message format dictates most of it). The implementer rewrote it as step-by-step parsing without being shown other code; the run is gone.

Exposure notes: builders saw the index of the owner's notes in their environment and did not open them.

Result: pass.
