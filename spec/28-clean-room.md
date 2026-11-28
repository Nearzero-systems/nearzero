# 28. Clean-room process and provenance

Nearzero 1.0 is written from this specification alone. This file is how the build stays independent and how anyone can check that it did.

## 28.1 Roles

| Role | May read | May write | Never |
| --- | --- | --- | --- |
| **Spec author** | Anything, including the 0.1.x codebase | `spec/` only, in behavioral terms | Writes implementation code; pastes code, identifiers, file names or internal structure from 0.1.x into `spec/` or into any message to an implementer |
| **Implementer** | `spec/`, this repository, official documentation of the third-party tools and libraries it uses | Everything outside `spec/` | Opens, lists, searches or reads the 0.1.x codebase, its git history, its notes, or the source of other self-hosted deployment platforms; copies code from anywhere into the repository except through declared dependencies |
| **Provenance reviewer** | The 0.1.x codebase and this repository | Reports under `provenance/` (pass or fail, file pairs, scores) | Shows old code to implementers; suggests fixes by quoting old code |
| **Coordinator** | Implementers' reports and this repository | Briefs that point at spec sections | Puts old-code details into briefs |

One person or agent holds one role for the whole build. A spec author never becomes an implementer.

## 28.2 Rules for implementers

1. Work only from `spec/`. When the spec is unclear, choose something reasonable, write the choice in your report under "Spec questions", and continue. Never resolve a question by looking at another project's source.
2. Name everything fresh: modules, files, tables, routes, variables. Names come from the spec's concepts (workspace, project, environment, service, server, hostname, deployment, task…), not from any other codebase.
3. Third-party code enters only as declared dependencies with permissive licenses (MIT, Apache-2.0, BSD, ISC, 0BSD, MPL-2.0 for unmodified use). No copied snippets, no vendored folders without their license file, no code from answers or blog posts longer than a few lines.
4. Every user-visible string comes from the spec or is newly written.
5. Every change states which spec sections it implements.

## 28.3 Architectural independence

The 1.0 stack (decision D5 in [25-open-decisions.md](25-open-decisions.md)) differs from the 0.1.x lineage in every layer that defines a platform's shape: the API style, the data access layer, the job system, the container orchestration, the per-server agent, and the repository layout. What stays the same is what the product is: its behavior and its look, which this spec defines.

## 28.4 Provenance checks

Run by the provenance reviewer before every release and at the end of every milestone:

| Check | Pass when |
| --- | --- |
| **Code similarity**: token-based clone detection between this repository and the 0.1.x codebase (and any other codebase the reviewer chooses), ignoring dependencies and generated files | No shared fragment of 50 tokens or more, except fragments that are standard boilerplate (license text, configuration a tool's docs prescribe), each listed with its reason |
| **Identifier audit**: distinctive internal names from the 0.1.x codebase (kept in the reviewer's private list, never in this repository) searched in this repository | No hits outside the documented public interface (install settings, command names, file paths people already use) |
| **Dependency licenses**: every dependency and its license | All permissive; no copyleft code linked into the product |
| **Strings**: user-visible strings traced to the spec | Every string is in the spec or new |

Reports go to `provenance/<milestone or version>.md` with the tools, their versions and the commits scanned, so anyone can rerun them.

## 28.5 Records

- Each commit says which spec sections it implements.
- Commits carry a Developer Certificate of Origin sign-off by the person responsible. Commits never carry AI tool attribution trailers.
- `provenance/LOG.md` records, per milestone, who implemented it (person or agent), from which spec files, and the provenance report.

## 28.6 Feedback loop

Implementers' "Spec questions" go to the spec author, who answers by editing `spec/` in behavioral terms. The answer never quotes old code. The implementer then reads the updated spec.
