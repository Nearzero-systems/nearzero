# Provenance report: parity rounds 2 and 3, the runner link, and the final verification

Date: 2026-11-28. Reviewer: provenance reviewer (has read the 0.1.x codebase; did not write code). Scanner and settings are the same as in [M0.md](M0.md): k = 50 tokens, exact and renamed passes. The scan covers the whole tree at commit e72b3b0: 1,018 source files, with build output under ignored folders left out.

This report covers everything after [final.md](final.md):
- round 2: spec 30, and the clean bug reports B1 to B3;
- round 3: spec 31, and the clean bug reports C1 to C3;
- the runner link security review, C4 and its re-check;
- the full verification pass;
- the brand kit (spec 21.9b).

| Pass | Shared runs of 50+ tokens |
| --- | --- |
| Exact | 2 places, both reviewed in [final.md](final.md) |
| Renamed | 12 places: 11 reviewed in [final.md](final.md), 1 new (below) |

No hits were found in the code rounds 2 and 3 added to:
- the control plane, the runner, the router, domains, backups or migration;
- the installer;
- the shared package;
- the new runner link client.

## Changes since final.md

- **Gone:** an intermediate scan at dacda73 found an exact run in the backups code's own table of reserved IPv4 ranges. The table matched a 0.1.x list of the same IANA special-purpose ranges, in their natural numeric order: a standards table, not a copy. The verification pass then replaced that code with the platform's single public-address check, built from IANA's IPv4 and IPv6 special-purpose registries (1fc3fb7). The run is gone.
- **New, not a copy:** the session list's compact relative time ("4m", "3h", "2d") matches a 0.1.x relative-time helper in the renamed pass. The shared part is the generic cascade of seconds, minutes, hours and days. The thresholds, the output form and the cut-offs differ.

## How rounds 2 and 3 kept the clean room

- Parity gaps came from dirty reviewers as behavior only. They were copied into the spec as 30a to 30d and 31a to 31d, each gap with an "Expected 1.0" acceptance line.
- Bug reports came from clean reviewers who read only 1.0's code.
- Eight clean builders fixed them in separate worktrees, followed by a clean verifier. No builder read 0.1.x code.
- The runner link was reviewed by a clean security reviewer.
- The 0.1.x side of the move (the exporter and the move harness) stayed in the 0.1.x repository. Its findings reached 1.0 only as behavior and runtime facts.

Result: pass.
