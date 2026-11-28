# Round 3: who fixes what

Sources:
- **Parity gaps:** [spec 31](../spec/31-parity-round-3.md), files 31a to 31d. Each gap's "Expected 1.0" line is spec, and the decisions in 31 settle the ones that offered a choice.
- **Bug reports:** the round 3 clean bug reports C1 (control plane and API), C2 (runner and installer) and C3 (console and Agent), kept outside this repository. These are clean-room reports on 1.0's own code, each with file, line, scenario and expected behavior.

Every item has exactly one owner. Fix P0 first, then P1, then P2. An item marked "needs a check" is confirmed or ruled out by its owner, with the result noted.

## W5: identity, access, the Agent and the console

- 31a: R1-02, G1-01 to G1-14
- 31d: R4-01, R4-09, G4-01, G4-03 to G4-10, G4-13, G4-14
- C1: 01, 06, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22
- C3: 01, 02, 05, 06, 07

Migrations: 0860 to 0899.

## W6: apps, Compose, databases, deploys, builds, deploy webhooks and backups

- 31b: R2-11, G2-01 to G2-08
- 31c: G3-03, G3-04, G3-20, G3-21
- 31d: G4-11, G4-15, G4-16, G4-17
- C1: 02, 03, 04, 10, 11, 12
- C2: 02, 03, 04, 05, 11
- C3: 03, 04

Migrations: 0900 to 0939.

## W7: the runner link, the installer, the `nearzero` command and outbound address checks

- 31c: G3-01 (see the decision in 31)
- 31d: R4-02, G4-02, G4-12, G4-18 to G4-24
- C1: 05, 08
- C2: 01, 06, 07, 08, 09, 10, 12 to 23

Migrations: 0940 to 0979.

## After W4: servers, domains, tasks, analytics, notifications and job lanes

These overlap what W4 is changing now, so they wait until W4's branch is on main.

- 31c: R3-03, R3-10, R3-11, R3-37, G3-02, G3-05 to G3-19
- 31d: R4-03, R4-14
- C1: 07, 09

Migrations: 0980 to 0999.
