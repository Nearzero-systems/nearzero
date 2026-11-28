# 05. Projects, environments, service copies and variables

## 5.1 Projects list

**Toolbar**: the page title "Projects" with **Create project** beside it (shown only to people allowed to create projects; owners and admins by default), a search box and a sort menu.
- Search: placeholder "Search by name or description...", case-insensitive over name and description, instant. Ctrl/Cmd+K focuses it. The query is kept in the address after a short pause so the view can be shared.
- Sort: Name (A-Z), Name (Z-A), Newest first (default), Oldest first, Most services, Least services. The choice is remembered in the browser.
- Footer: "N total" or "N of M total".
- On phones the search gets its own row and the sort control the next.

**Cards**: name; description (two lines at most); "Created <relative time>" (full date on hover); "N service(s)" across all environments. No tags.
- Clicking opens the project's "development" environment, else its default environment, else the first, on Overview.
- A card with no environment the viewer can open shows "No environments available" and is not clickable.
- Empty: "No projects found" / "Create a project to start deploying services."; with a search: "Try adjusting your search."

**Create** (dialog "Add a project"): Name (required, up to 100 characters) and Description (optional, up to 1,000). Empty name: "Project name is required". Success: toast "Project created" and the new project's development environment opens. Every new project starts with exactly one environment, "development", which is its default. Names need not be unique.

**Card menu**
- **Update** ("Update project", "Change the project name or description."): Name (required), Description. Toast "Project updated". Shown only to people who can change the project (today it shows for everyone and the server refuses).
- **Delete** (people allowed to delete projects):
  - The dialog loads a plan: every service in every environment with its server, each marked "Production" or "No access".
  - Text: "Delete X and remove its N services from their servers? Their containers, volumes, files, logs, images, domains and DNS records are wiped from the servers. This cannot be undone." With no services: "Delete X? It has no services."
  - Warnings: "You can't delete N services in this list, so nothing will be deleted. Ask an owner or admin." (the confirm field is hidden) and "N services run in production."
  - The person types the project name; the button reads "Delete project and N services".
  - It runs in the background with a state per service (Waiting, Removing…, Removed, Not removed): "You can close this; the delete keeps going." Reopening shows "X is already being deleted."
  - If any service fails, the project is kept ("The project was kept") with the reason per service, and the delete can be retried.
  - If the project changed after the plan was shown, the delete is refused and the plan reloads.
  - If the platform restarted mid-delete, the dialog says the delete is no longer tracked and offers to start it again.

**Acceptance**
- A project with services on two servers deletes completely: afterwards neither server has any container, volume, folder, image, route or DNS record of it.
- A member who cannot delete one of the services sees why and nothing is deleted.

## 5.2 Project workspace

**Navigation**: a project column titled with the project name: **Overview** and **Services** (and **Variables**, see 5.5). Below 1024px it becomes a row of tabs. An unknown section in the address goes to Overview.

**Project switcher** (the project name in the header breadcrumb): opens a "Projects" menu listing every project the person can see, with a check on the current one; picking one opens the same section in that project.

**Environment switcher** (in the header breadcrumb: project / environment):
- Lists the environments with a check on the current one. Switching keeps the same section (Overview, Services, Variables, new application); from a service's page it goes to Overview.
- A **PRODUCTION** badge shows when the environment is named exactly "production" (hidden on the narrowest screens).
- **Add environment** for owners, admins and people allowed to create environments.

**Overview**
- Title "Overview" and **Add New** with: **Application** (the new-application page), **Compose** (new in the console for 1.0; see [07-compose.md](07-compose.md)), **Database** (the database dialog), **Domain** (the Add domain dialog; disabled with "Deploy an application or Compose service before adding a domain." when there is none).
- **Canvas**: services whose last deploy succeeded.
  - Empty: "No active services" / "Deploy a service successfully to see live applications, databases, and compose services here." and "Deploy your first application →".
  - Service card: name, type, a status pill (Running, Deploying, Error, Not running) and a detail row: apps show "Framework" (detected framework, else build type, else "Unknown"); other services show "Runtime".
  - Apps and Compose services have domain cards in a third lane, joined by lines labelled "Domain". A domain card's pill is "Live", or "Needs DNS record" (amber) with a hint naming the A record to add. The DNS check behind it is capped at 4 seconds; on timeout the card shows "Checking…" rather than guessing "Live".
  - A service with no domain gets a dashed **"No domain yet"** card joined by a dashed line: with permission to add domains, "Give X a public URL with HTTPS." plus **Generate domain** and **Use my domain** (both open the Add domain dialog with the service chosen); without it, "X isn't reachable from the internet yet."
  - Cards can be dragged on desktop to tidy the view (after a 6px movement, never from their buttons). Positions are not saved.
  - At 640px and below the canvas becomes a list (see [21-design-system.md](21-design-system.md) 21.8).
- "All services" below the canvas with "View all".

**Services page**: every service in the environment with its status.
- Row menu: "Open service", "Delete service".
- Bulk: "Select all", "N selected", "Delete N selected", which opens the teardown dialog of 5.1 for those services (the person types the project name).
- Deleting is refused while a service is deploying ("Wait for the deployment to finish before deleting this service."). A running service is stopped as part of its deletion. The same rule applies to single and bulk deletes (today bulk delete ignores the deploying check and single delete also refuses running services).

**Delete service dialog** ("This service and its data will be removed."):
- Text: "…Nearzero removes it and everything it keeps on its server: containers, volumes, files, logs, images, domains and DNS records. This cannot be undone." The person types the service name.
- If the service has copies in other environments the viewer can open: a fieldset "The same service in other environments", one checkbox per copy ("env (name)"), all unticked, hint "Only this environment's copy is deleted unless you tick others."
- Results: "Service removed", or a persistent "Service removed, but not everywhere" naming what failed.

## 5.3 Environments

**Add environment** dialog ("Each environment has its own services and variables."):
- **Name** (placeholder "staging"): trimmed and lowercased; spaces and underscores become dashes; repeated dashes collapse; up to 32 characters; letters, numbers and dashes ("Use letters, numbers and dashes, like staging or qa-2.").
  - "prod" and "prd" are refused: "Name it "production" instead…".
  - Duplicates: "This project already has an environment called "x"."
  - Live hint: "It will be called x.", "This is your production environment." or "Looks good."
- **Variables**: "Start empty" or "Copy names from <environment>". With a source, an "Also copy the values" checkbox. Hints: "Names from X are copied with empty values. Fill them in after." / "The values from X, secrets included, will be copied [into production]."
- **Description**: optional, up to 1,000 characters.
- "Create environment" → toast "Created <name>" and the new environment opens. Every service of the project is then copied into it (5.4).

**Rename and delete** (added to the console in 1.0; today they exist only in the API):
- Rename from the environment menu, same name rules. The default environment can be renamed but not deleted.
- Delete is allowed only when the environment has no services ("Delete or move its N services first."), and only for people allowed to delete environments. Typing the environment name confirms.

**Production**: an environment is production exactly when it is named "production". Production gets the badge, the Agent's production gate, and the warning on shared variables (5.5).

**Acceptance**
- "QA Team" becomes "qa-team"; "prod" is refused with the hint; a second "staging" is refused.
- Creating an environment in a project with three services gives the new environment three idle services with variable names and no values (unless values were chosen).

## 5.4 Service copies across environments

All environments of a project hold the same set of services.

| Rule | Detail |
| --- | --- |
| Adding a service | Adds it to every environment of the project where the person may add services. The other copies keep the same name and settings. |
| What a copy gets | Its own variables (names only, empty values), its own internal app name, its own volumes, its own hostname (assigned at first deploy), and for databases its own generated password and public port. Never the original's domains, ports or secrets. |
| Deploying | Copies are never deployed automatically. |
| Source | A copy without a Git or image source takes its group's source at its first deploy. |
| Telling the person | Every create (app, Compose, database, from the console or the Agent) says where else it was added: "Also added to staging and production, not deployed yet. Each environment has its own variables and URL." (Today only the database dialog says it.) |
| Deleting | Asks each time which other copies to delete (5.2). |
| Linking | Copies are linked explicitly. For services created before linking existed, copies are matched by name. |
| Names | Service names are unique within an environment, ignoring case (up to 100 characters). Where a copy's name is already taken in another environment, that copy is skipped and the create says so. |
| Values | "Also copy the values" copies only values the person creating the environment may read. |

**Acceptance**: adding a Postgres database in development adds idle copies in staging and production with different passwords and public ports; deploying staging's copy does not touch the others.

## 5.5 Variables

Two levels in 1.0: **shared variables** of an environment and **a service's own variables**. (A third, project-level layer exists in today's API with no screen; 1.0 drops it, and the migration copies any project-level values into each environment's shared variables.)

**Shared variables page** ("Shared variables", "Only for <environment>. Other environments have their own.")
- Text: "Every service in <environment> gets these on each deploy. A service's own variable with the same name wins. To use one inside another value, write `${{environment.NAME}}`."
- On production: "This is production. Saved changes reach services when they next deploy."
- Values masked; empty ones show "empty"; "Show values" / "Hide values".
- Who sees what (the C1-20 decision in spec 31): anyone who can see the environment sees the names; anyone who may deploy, edit the variables of or open the terminal of at least one service in it may also show the values (every service receives them anyway); **Edit** needs access to the whole environment ("Editing them needs access to the whole environment, since they reach every service in it. Ask an owner or admin."). Someone who sees the environment but none of its services gets "You can see the names. Their values are for people who can deploy a service in this environment or edit its variables. Ask an owner or admin." Without access to the environment: "You can't see this environment's variables. Ask an owner or admin for access."
- Empty: "No shared variables yet" and **Add variable**.
- A "Service variables" list links to each service's own Variables tab with its count.
- Reached from the project column and from "Edit shared" on any service's Variables tab.

**A service's Variables tab** (apps and databases; a section on the Compose page)
- "Variables", "Only for X in <environment>. The same service in another environment has its own."
- "Its own": a count and **Edit** (needs permission to write service variables). Empty: "No variables of its own yet."
- "Shared in <environment>": read-only; a shared name the service overrides is marked "(its own wins)"; **Edit shared**.
- Saving: toast "Variables saved", "They reach the service on its next deploy."
- Up to 256 KB of text per service.

**The editor** (shared and own)
- Rows of name and value; values hidden; browser autofill suppressed; a remove button per row; "Add variable", "Show values", "Edit as .env" / "Use the form", "Cancel", "Save variables".
- Text mode hint: "One per line, NAME=value. Lines starting with # are comments."
- Comments are kept exactly: shown above their rows with "Comments are kept as they are. To change them, use Edit as .env."
- Pasting a whole env file into any box fills the rows: "Added N variables and updated M from the paste.", "Left out lines …: not one-line NAME=value.", "Comments in the paste were left out."
- Text the form can't hold exactly opens as text with the reason, "so nothing is changed or lost".
- Names start with a letter or `_`, then letters, digits, `_`, `.` or `-`.
- Values are taken literally: no escape sequences and no comments after a value. A value may be wrapped in matching single or double quotes; text after the closing quote, and lines starting with `export`, are refused with the line number.
- Save is blocked, with the line named, for: a line that is not NAME=value; a name set twice ("X is set twice, on lines A and B. Keep one."); a value over several lines; a value with no name; an invalid name; a value containing all three quote characters.

**How values reach a service**
- At deploy, a service gets the environment's shared variables, then its own; its own wins on a clash.
- References: `${{environment.NAME}}` (a shared variable) and `${{NAME}}` (the service's own). An unknown reference fails the deploy with the name.
- Builds receive only names made of letters, digits and `_`.
- Compose services receive their own variables as an env file passed to Compose (use `${VAR}` in the YAML). Compose never inherits Docker or Compose control variables (names starting DOCKER_ or COMPOSE_, PATH, HOME) from shared variables.
- Secret-looking names with a public prefix (NEXT_PUBLIC_, VITE_, PUBLIC_, REACT_APP_, NUXT_PUBLIC_) get a warning, because those reach browsers.

**Acceptance**
- An env file with comments survives save and reload byte for byte in text mode.
- A service with its own `API_URL` and a shared `API_URL` receives its own.
- `${{environment.MISSING}}` fails the deploy with "MISSING" in the log.
