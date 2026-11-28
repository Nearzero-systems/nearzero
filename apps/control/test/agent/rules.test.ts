import { describe, expect, test } from "bun:test";
import {
  attachmentSizeProblem,
  classifyAttachment,
  cleanGeneratedTitle,
  filterSuggestions,
  isTextContent,
  provisionalTitle,
  sessionTitleProblem,
  stripInternalIds,
  turnFooter,
} from "@nearzero/shared";
import { modelResultText, safeTarget } from "../../src/agent/capability.ts";
import { normalizeGitUrl } from "../../src/agent/catalog/apps.ts";
import { isGenericProjectName } from "../../src/agent/catalog/projects.ts";
import { composeYamlProblem } from "../../src/agent/catalog/services-more.ts";
import { docxText, pdfPages, zipEntry } from "../../src/agent/extract.ts";
import { carriesSecret } from "../../src/agent/messages.ts";
import { redactForModel, redactText, secretLookingInput } from "../../src/agent/redact.ts";
import { pageUrlProblem } from "../../src/agent/research.ts";
import { editDistance, matchByName, typoAllowance } from "../../src/agent/resolve.ts";
import { IdSafeText } from "../../src/agent/text-stream.ts";
import { makePdf, makeZip } from "./builders.ts";

const ID = "3f2a9c1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f";

describe("ids never reach the screen (spec 19.4, 19.11)", () => {
  test("stripInternalIds removes labelled, bracketed, quoted and bare ids", () => {
    expect(stripInternalIds(`Deployed web (id: ${ID}).`)).toBe("Deployed web.");
    expect(stripInternalIds(`Deployed web [${ID}] now`)).toBe("Deployed web now");
    expect(stripInternalIds(`The service \`${ID}\` is up`)).toBe("The service is up");
    expect(stripInternalIds(`web, id: ${ID}, is up`)).toBe("web, is up");
    expect(stripInternalIds(`ref ${ID}`)).toBe("ref ");
    expect(stripInternalIds("Nothing to strip: 1234-5678")).toBe("Nothing to strip: 1234-5678");
    expect(stripInternalIds("| web | prod-1 |\n| --- | --- |")).toBe(
      "| web | prod-1 |\n| --- | --- |",
    );
  });

  test("ids split over several deltas are still removed", () => {
    const stream = new IdSafeText();
    const pieces = [
      "Deployed web (id",
      ": 3f2a9c1e-8b7d",
      "-4c6a-9e5f-1a2b3c4d5e6f) and ",
      "it's live.",
    ];
    let shown = "";
    for (const piece of pieces) shown += stream.push(piece);
    shown += stream.flush();
    expect(shown).toBe("Deployed web and it's live.");
    const bare = new IdSafeText();
    let text = "";
    for (const piece of ["See 3f2a9c1e-8b7d-", "4c6a-9e5f-", "1a2b3c4d5e6f for more"])
      text += bare.push(piece);
    text += bare.flush();
    expect(text).toBe("See for more");
  });

  test("step targets never carry ids or credentials", () => {
    expect(safeTarget(`web (${ID}) on prod-1`)).toBe("web on prod-1");
    expect(safeTarget("https://user:hunter2@git.example.com/acme/web")).toBe(
      "https://git.example.com/acme/web",
    );
  });
});

describe("titles and the footer (spec 19.4, 19.5)", () => {
  test("provisional titles take the first 8 words, at most 72 characters, without quotes", () => {
    expect(
      provisionalTitle('Deploy "acme/web" to prod-1 and then tell me what happens next please'),
    ).toBe("Deploy acme/web to prod-1 and then tell me");
    expect(provisionalTitle(`${"a".repeat(100)} b`)).toHaveLength(72);
    expect(provisionalTitle("", ["error.log", "b.png"])).toBe("error.log");
    expect(provisionalTitle("")).toBeNull();
  });

  test("generated titles are 2 to 5 words in sentence case, or Greeting", () => {
    expect(cleanGeneratedTitle('"deploying the web app."')).toBe("Deploying the web app");
    expect(cleanGeneratedTitle("Title: Server setup help")).toBe("Server setup help");
    expect(cleanGeneratedTitle("Greeting")).toBe("Greeting");
    expect(cleanGeneratedTitle("Deploy")).toBeNull();
    expect(cleanGeneratedTitle("one two three four five six")).toBeNull();
  });

  test("renames are one line of 1 to 80 characters", () => {
    expect(sessionTitleProblem("  ")).toBe("Enter a name for the session.");
    expect(sessionTitleProblem("x".repeat(81))).toBe("Session names can be up to 80 characters.");
    expect(sessionTitleProblem("Fine")).toBeNull();
  });

  test("footers count only working time, steps and failures", () => {
    expect(
      turnFooter({
        state: "finished",
        stoppedBy: null,
        workedMs: 34_200,
        steps: 3,
        failedSteps: 1,
      }),
    ).toBe("Worked for 34s · 3 steps · 1 failed");
    expect(
      turnFooter({ state: "finished", stoppedBy: null, workedMs: 900, steps: 1, failedSteps: 0 }),
    ).toBe("Worked for 1s · 1 step");
    expect(
      turnFooter({
        state: "stopped",
        stoppedBy: "person",
        workedMs: 12_000,
        steps: 2,
        failedSteps: 0,
      }),
    ).toBe("Stopped after 12s");
    expect(
      turnFooter({ state: "stopped", stoppedBy: "restart", workedMs: 1, steps: 0, failedSteps: 0 }),
    ).toBe("Stopped (Nearzero restarted)");
  });
});

describe("follow-ups (spec 19.4)", () => {
  test("keep up to three short ones the Agent can do, in the person's words", () => {
    expect(
      filterSuggestions([
        "1. Deploy web again",
        "- Open port 22 on the firewall",
        "Reboot prod-1",
        "Would you like me to redeploy?",
        "Show me the full log of the latest web deployment with every detail please",
        `Check ${ID}`,
        "Deploy web again",
        "Show logs for api",
        "Add a domain to web",
        "Set up prod-2",
      ]),
    ).toEqual(["Deploy web again", "Show logs for api", "Add a domain to web"]);
  });
});

describe("attachments (spec 19.10)", () => {
  test("kinds by name, with refused kinds and their reasons", () => {
    expect(classifyAttachment("shot.PNG")).toMatchObject({
      ok: true,
      kind: "image",
      contentType: "image/png",
    });
    expect(classifyAttachment("spec.pdf")).toMatchObject({ ok: true, kind: "pdf" });
    expect(classifyAttachment("notes.docx")).toMatchObject({ ok: true, kind: "docx" });
    expect(classifyAttachment("server.ts")).toMatchObject({ ok: true, kind: "text" });
    expect(classifyAttachment("Dockerfile")).toMatchObject({ ok: true, kind: "text" });
    expect(classifyAttachment("demo.mov")).toMatchObject({ ok: true, kind: "video" });
    expect(classifyAttachment(".env.example")).toMatchObject({ ok: true, kind: "text" });
    expect(classifyAttachment(".env.sample")).toMatchObject({ ok: true, kind: "text" });
    expect(classifyAttachment("prod.env.template")).toMatchObject({ ok: true });
    for (const name of [".env", ".env.local", ".env.production", "prod.env"]) {
      expect(classifyAttachment(name)).toMatchObject({ ok: false });
      expect((classifyAttachment(name) as { reason: string }).reason).toContain(
        "Env files can hold secrets",
      );
    }
    expect(classifyAttachment("budget.xlsx")).toEqual({
      ok: false,
      reason: "Export it as CSV or PDF, then attach that.",
    });
    expect(classifyAttachment("deck.pptx")).toEqual({
      ok: false,
      reason: "Export it as CSV or PDF, then attach that.",
    });
    expect(classifyAttachment("old.doc")).toEqual({
      ok: false,
      reason: "Save it as .docx or PDF, then attach that.",
    });
    expect((classifyAttachment("site.zip") as { reason: string }).reason).toContain("Archives");
    expect((classifyAttachment("photo.heic") as { reason: string }).reason).toContain(
      "HEIC and AVIF",
    );
    expect((classifyAttachment("photo.avif") as { reason: string }).reason).toContain(
      "HEIC and AVIF",
    );
    expect(classifyAttachment("tool.exe")).toMatchObject({ ok: false });
  });

  test("31d G4-09: logs, diffs and other text files 0.1.x read are text, in every browser", () => {
    for (const name of [
      "build.out",
      "app.err",
      "fix.patch",
      "change.diff",
      "events.jsonl",
      "events.ndjson",
      "notes.text",
      "logo.svg",
      "app.config",
      ".nvmrc",
      "config.yml.example",
      "settings.sample",
      "nginx.conf.template",
      "Brewfile",
    ]) {
      expect(classifyAttachment(name, "application/octet-stream")).toMatchObject({
        ok: true,
        kind: "text",
      });
    }
    // Their bytes decide: text is kept, anything else is refused.
    expect(isTextContent(new TextEncoder().encode("line one\nline two ✓\n"))).toBe(true);
    expect(isTextContent(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x00, 0x00]))).toBe(
      false,
    );
    expect(isTextContent(Uint8Array.from([0xff, 0xfe, 0x41, 0x42]))).toBe(false);
  });

  test("each kind has its own size limit", () => {
    const mb = 1024 * 1024;
    expect(attachmentSizeProblem("image", 10 * mb)).toBeNull();
    expect(attachmentSizeProblem("image", 10 * mb + 1)).toContain("Images can be up to 10 MB");
    expect(attachmentSizeProblem("pdf", 20 * mb + 1)).toContain("PDFs can be up to 20 MB");
    expect(attachmentSizeProblem("docx", 15 * mb + 1)).toContain(
      "Word documents can be up to 15 MB",
    );
    expect(attachmentSizeProblem("text", 10 * mb + 1)).toContain("Text files can be up to 10 MB");
    expect(attachmentSizeProblem("video", 25 * mb + 1)).toContain("Videos can be up to 25 MB");
    expect(attachmentSizeProblem("text", 0)).toBe("This file is empty.");
  });

  test("Word documents and PDFs are read for text", async () => {
    const docx = makeZip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        '<w:document><w:body><w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Second </w:t></w:r><w:r><w:t>line</w:t></w:r></w:p></w:body></w:document>',
    });
    expect(docxText(docx)).toBe("Hello & welcome\nSecond line");
    expect(zipEntry(docx, "missing.xml")).toBeNull();
    expect(await pdfPages(makePdf(["First page text", "Second page text"]))).toEqual([
      "First page text",
      "Second page text",
    ]);
    expect(await pdfPages(new TextEncoder().encode("not a pdf"))).toBeNull();
  });
});

describe("finding things (spec 19.11)", () => {
  test("typo tolerance: none under 4 letters, 1 for 4 to 7, 2 for 8 or more", () => {
    expect(typoAllowance(3)).toBe(0);
    expect(typoAllowance(4)).toBe(1);
    expect(typoAllowance(7)).toBe(1);
    expect(typoAllowance(8)).toBe(2);
    expect(editDistance("backend", "bakcend")).toBe(1);
    expect(editDistance("frontend", "frnotedn")).toBe(2);
    expect(editDistance("frontend", "frntnd")).toBe(2);
  });

  test("exact names, aliases, typos and ambiguity", () => {
    const items = [
      { id: "1", name: "backend", aliases: ["shop-backend-x1y2z3"] },
      { id: "2", name: "frontend" },
      { id: "3", name: "web" },
      { id: "4", name: "worker-eu" },
      { id: "5", name: "worker-us" },
    ];
    expect(matchByName(items, "Backend")).toMatchObject({
      kind: "one",
      exact: true,
      item: { id: "1" },
    });
    expect(matchByName(items, "bakcend")).toMatchObject({
      kind: "one",
      exact: false,
      item: { id: "1" },
    });
    expect(matchByName(items, "fronted")).toMatchObject({ kind: "one", item: { id: "2" } });
    expect(matchByName(items, "frnotedn")).toMatchObject({ kind: "one", item: { id: "2" } });
    expect(matchByName(items, "frntnd")).toEqual({ kind: "none" });
    expect(matchByName(items, "wbe")).toEqual({ kind: "none" });
    expect(matchByName(items, "shop-backend-x1y2z3")).toMatchObject({
      kind: "one",
      item: { id: "1" },
    });
    expect(matchByName(items, "worker-ex")).toMatchObject({ kind: "one", item: { id: "4" } });
    expect(matchByName(items, "worker-xx")).toMatchObject({ kind: "many" });
    expect(matchByName(items, "worker eu")).toMatchObject({ kind: "one", item: { id: "4" } });
  });
});

describe("secrets never reach the model (spec 19.11, 23.4)", () => {
  test("results lose secret fields, tokens and URL credentials", () => {
    const redacted = redactForModel({
      name: "web",
      settings: {
        source: { type: "raw", composeFile: "services: {}" },
        registry: { passwordSet: true, password: "p4ss" },
      },
      variables: [{ name: "API_KEY", value: "abc" }],
      url: "https://deploy:tok3n@github.com/acme/web.git",
      log: "token ghp_abcdefghijklmnopqrstuvwx12 and key sk-or-v1-abcdef0123456789",
      key: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
    }) as Record<string, unknown>;
    const text = JSON.stringify(redacted);
    for (const secret of [
      "services: {}",
      "p4ss",
      'abc"',
      "tok3n",
      "ghp_abcdefghijklmnopqrstuvwx12",
      "sk-or-v1-abcdef0123456789",
      "AAAA",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("passwordSet");
    expect(text).toContain("https://github.com/acme/web.git");
    expect(redactText("postgres://app:s3cret@db:5432/app")).toBe("postgres://db:5432/app");
  });

  test("secret-looking commands and inputs are refused", () => {
    expect(secretLookingInput("npm run build")).toBeNull();
    expect(secretLookingInput("API_KEY=abc123 npm start")).toContain("refused");
    expect(
      secretLookingInput("export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxx && make"),
    ).toContain("refused");
    expect(secretLookingInput("psql --password=hunter22")).toContain("refused");
    expect(secretLookingInput("DATABASE_PASSWORD=$DB_PASS node app")).toBeNull();
    expect(secretLookingInput("-----BEGIN RSA PRIVATE KEY-----")).toContain("private key");
  });

  test("Compose YAML with values or config contents is refused; placeholders are fine", () => {
    expect(
      composeYamlProblem(
        `services:\n  web:\n    image: nginx\n    environment:\n      PORT: $\{PORT}\n`,
      ),
    ).toBeNull();
    expect(
      composeYamlProblem(
        "services:\n  web:\n    image: nginx\n    environment:\n      - TOKEN=abc\n",
      ),
    ).toContain("TOKEN");
    expect(
      composeYamlProblem("services:\n  web:\n    environment:\n      PASSWORD: hunter2\n"),
    ).toContain("PASSWORD");
    expect(
      composeYamlProblem(
        "services:\n  web:\n    image: x\nconfigs:\n  app:\n    content: secret\n",
      ),
    ).toContain("contents");
    expect(composeYamlProblem("not: [valid")).toContain("isn't valid YAML");
  });

  test("form answers and messages marked secret are refused", () => {
    expect(carriesSecret({ outcome: "saved", names: ["A"] }, true)).toBe(false);
    expect(carriesSecret({ outcome: "saved", value: "x" }, true)).toBe(true);
    expect(carriesSecret({ outcome: "saved", nested: { privateKey: "x" } }, true)).toBe(true);
    expect(carriesSecret({ text: "hi", secret: true }, false)).toBe(true);
    expect(carriesSecret({ text: "my value is fine" }, false)).toBe(false);
  });

  test("results reach the model cut at 12,000 characters", () => {
    const text = modelResultText({ log: "x".repeat(20_000) });
    expect(text.length).toBeLessThan(12_100);
    expect(text).toContain("[Result cut at 12,000 characters.]");
  });
});

describe("small rules", () => {
  test("generic project names are refused (spec 20.1)", () => {
    for (const name of ["new project", "My project", "project 2", "Untitled", "project"])
      expect(isGenericProjectName(name)).toBe(true);
    for (const name of ["shop", "web project x", "Projections"])
      expect(isGenericProjectName(name)).toBe(false);
  });

  test("Git URLs: bare host/owner/repo becomes https; credentials stay for the area to refuse", () => {
    expect(normalizeGitUrl("github.com/acme/web")).toBe("https://github.com/acme/web");
    expect(normalizeGitUrl("git@github.com:acme/web.git")).toBe("git@github.com:acme/web.git");
  });

  test("research pages are http and https only", () => {
    expect(pageUrlProblem("https://docs.example.com")).toBeNull();
    expect(pageUrlProblem("file:///etc/passwd")).toBe("Only http and https pages can be read.");
    expect(pageUrlProblem("https://u:p@example.com")).toContain("user name or password");
  });
});

describe("the capability catalog (spec 20)", () => {
  test("every row of spec 20 is offered, with labels, policies and a JSON schema", async () => {
    const { capabilityCatalog } = await import("../../src/agent/catalog/index.ts");
    const { toolDefinitions } = await import("../../src/agent/capability.ts");
    const catalog = capabilityCatalog();
    const names = catalog.map((capability) => capability.name);
    expect(new Set(names).size).toBe(names.length);
    for (const expected of [
      // 20.1 projects and environments
      "list_projects",
      "read_project",
      "create_project",
      "update_project",
      "create_environment",
      "delete_project",
      // 20.2 finding
      "find_service",
      // 20.3 applications
      "create_app_from_provider",
      "create_app_from_git_url",
      "create_app_from_image",
      "change_app_source",
      "change_app_build",
      "add_port",
      "add_mount",
      "request_variables",
      "read_push_deploys",
      "change_push_deploys",
      "copy_service_to_environments",
      // 20.4 Compose, 20.5 databases, 20.6 domains
      "create_compose_from_yaml",
      "create_compose_from_repository",
      "create_database",
      "add_hostname",
      // 20.7 deploying, 20.8 logs
      "deploy_service",
      "service_action",
      "follow_deployment",
      "list_deployments",
      "read_deployment_log",
      "read_service_logs",
      "compare_service_status",
      "analyze_logs",
      // 20.9 servers, 20.10 SSH keys, 20.11 Git providers
      "list_servers",
      "read_server",
      "add_server",
      "update_server",
      "run_server_setup",
      "validate_server",
      "read_setup_log",
      "security_audit",
      "remove_server",
      "request_ssh_key",
      "list_ssh_keys",
      "rename_ssh_key",
      "delete_ssh_key",
      "list_git_providers",
      "list_repositories",
      "list_branches",
      "inspect_repository",
      // 20.12 tasks, 20.13 research and attachments, 20.14 not offered
      "list_tasks",
      "review_task",
      "create_task",
      "update_task",
      "replace_task_script",
      "run_task",
      "search_web",
      "read_web_page",
      "list_files",
      "read_file",
      "console_page",
    ]) {
      expect(names).toContain(expected);
    }
    const policyOf = Object.fromEntries(
      catalog.map((capability) => [capability.name, capability.policies]),
    );
    // Spec 19.9 defaults per capability.
    expect(policyOf.create_project).toEqual(["projects.create"]);
    expect(policyOf.delete_project).toEqual(["projects.delete-without-production"]);
    expect(policyOf.create_app_from_git_url).toEqual(["services.configure", "services.import-git"]);
    expect(policyOf.add_hostname).toEqual(["services.configure", "services.assign-domains"]);
    expect(policyOf.deploy_service).toEqual(["services.deploy"]);
    expect(policyOf.list_ssh_keys).toEqual(["ssh-keys.read"]);
    expect(policyOf.remove_server).toEqual(["servers.remove"]);
    expect(policyOf.create_task).toEqual(["tasks.run"]);
    expect(policyOf.list_projects).toEqual([]);
    for (const capability of catalog) {
      expect(capability.label.running).not.toBe("");
      expect(capability.label.done).not.toBe("");
      if (capability.changes && capability.name !== "console_page")
        expect(capability.policies.length).toBeGreaterThan(0);
    }
    const tools = toolDefinitions(catalog);
    expect(tools.every((tool) => tool.function.parameters.type === "object")).toBe(true);
    const deploy = tools.find((tool) => tool.function.name === "deploy_service");
    expect(Object.keys(deploy?.function.parameters.properties as object)).toEqual([
      "service",
      "project",
      "environment",
      "cleanCache",
    ]);
  });
});
