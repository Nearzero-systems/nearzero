import { describe, expect, test } from "bun:test";
import {
  describeOption,
  namesFromExample,
  namesFromSchema,
  runOptions,
  variableNames,
} from "../../src/agent/flows/inspect.ts";
import {
  failedWhileBuilding,
  lastLines,
  missingTool,
  missingVariables,
} from "../../src/agent/flows/log-rules.ts";
import { intentOf, splitClauses } from "../../src/agent/flows/parse.ts";

/** The guided flows' reading of messages, repositories and logs (spec 19.7), without a database. */

const intents = (text: string) => (splitClauses(text) ?? []).map((clause) => intentOf(clause));

describe("clauses (spec 19.7)", () => {
  test("several clauses run in order; connectors split only before a request", () => {
    expect(splitClauses("delete shop and then create a project called web")).toEqual([
      "delete shop",
      "create a project called web",
    ]);
    expect(splitClauses("Deploy web. Then delete project old")).toEqual([
      "Deploy web",
      "delete project old",
    ]);
    expect(splitClauses("create a project called rock and roll")).toEqual([
      "create a project called rock and roll",
    ]);
    expect(splitClauses("delete live and shop")).toEqual(["delete live and shop"]);
    expect(splitClauses("Can you create a project named shop please?")).toEqual([
      "create a project named shop",
    ]);
  });

  test("long messages and code are the model's", () => {
    expect(splitClauses(`deploy web ${"x".repeat(500)}`)).toBeNull();
    expect(splitClauses("deploy this:\n```\nFROM node\n```")).toBeNull();
  });
});

describe("create a project", () => {
  test("named, generic and nameless", () => {
    expect(intentOf("create a project called shop")).toEqual({
      flow: "create_project",
      name: "shop",
    });
    expect(intentOf('set up a project named "Shop Front"')).toEqual({
      flow: "create_project",
      name: "Shop Front",
    });
    for (const text of [
      "make a project",
      "create a new project",
      "create project 2",
      "add a project called my project",
      "start a project called untitled",
    ]) {
      expect(intentOf(text)).toEqual({ flow: "create_project", name: null });
    }
  });

  test("not triggered by pronouns, other resources, long or prepositional names, or mere mentions", () => {
    for (const text of [
      "start it again",
      "create a service called project",
      "create a project for my blog",
      "create a project called one two three four five six seven",
      "how do I create a project?",
      "the project I create is slow",
    ]) {
      expect(intentOf(text)?.flow).not.toBe("create_project");
    }
  });

  test('"create a project and start it again" never names a project "it again"', () => {
    const all = intents("create a project and start it again");
    expect(all).toEqual([{ flow: "create_project", name: null }, null]);
    expect(JSON.stringify(all)).not.toContain("it again");
  });
});

describe("delete a project", () => {
  test("verbs, names and lists", () => {
    expect(intentOf("delete the shop project")).toEqual({
      flow: "delete_project",
      names: ["shop"],
      saidProject: true,
    });
    expect(intentOf("get rid of shop")).toEqual({
      flow: "delete_project",
      names: ["shop"],
      saidProject: false,
    });
    expect(intentOf("delete live and shop")).toEqual({
      flow: "delete_project",
      names: ["live", "shop"],
      saidProject: false,
    });
  });

  test("negation and other kinds of things are the model's unless project is said", () => {
    for (const text of [
      "don't delete web",
      "do not remove shop",
      "delete the web service",
      "remove the database in project shop",
      "drop the logs",
      "delete branch feature-x",
      "remove the ssh key",
      "delete all projects",
    ]) {
      expect(intentOf(text)).toBeNull();
    }
  });

  test('"remove the sdrever" asks only for an exact project name (checked against projects)', () => {
    expect(intentOf("remove the sdrever")).toEqual({
      flow: "delete_project",
      names: ["sdrever"],
      saidProject: false,
    });
  });
});

describe('"deploy <name>"', () => {
  test("the short pattern", () => {
    expect(intentOf("deploy web")).toEqual({ flow: "deploy_name", name: "web" });
    expect(intentOf("please redeploy the api service again")).toEqual({
      flow: "deploy_name",
      name: "api",
    });
    expect(intentOf("ship our shop-front app now")).toEqual({
      flow: "deploy_name",
      name: "shop-front",
    });
    expect(intentOf("deploy acme/web")).toEqual({ flow: "deploy_name", name: "acme/web" });
  });

  test("pronouns, generic words and Git URLs are not names", () => {
    expect(intentOf("deploy it")).toBeNull();
    expect(intentOf("deploy everything")).toBeNull();
    expect(intentOf("deploy cache a lot")).toBeNull();
    // A link to one of the four public hosts is the checked import's (30d R4-01), never a name.
    expect(intentOf("deploy github.com/acme/web")).toMatchObject({ flow: "git_link" });
    expect(intentOf("deploy https://gitlab.example.com/acme/web.git")).toBeNull();
    expect(intentOf("deploy git@github.com:acme/web.git")).toBeNull();
  });
});

describe("import from Git", () => {
  test("triggers, with what the message already says", () => {
    expect(intentOf("Deploy a Git repository")).toMatchObject({
      flow: "git_import",
      repository: null,
      deploy: true,
    });
    expect(intentOf("import acme/web into shop on prod-1")).toEqual({
      flow: "git_import",
      repository: "acme/web",
      provider: null,
      project: "shop",
      server: "prod-1",
      branch: null,
      deploy: true,
      name: null,
      builder: null,
      folder: null,
    });
    expect(intentOf("just import my billing repo from gitlab")).toMatchObject({
      repository: "billing",
      provider: "gitlab",
      deploy: false,
    });
    expect(intentOf("import the shop repo, branch develop, and don't deploy")).toMatchObject({
      repository: "shop",
      branch: "develop",
      deploy: false,
    });
    expect(intentOf("connect my GitHub")).toMatchObject({ flow: "git_import", provider: "github" });
    // Common words count only as owner/name or right before "repo".
    expect(intentOf("import my web app")).toMatchObject({ repository: null });
    expect(intentOf("import the web repo")).toMatchObject({ repository: "web" });
  });

  test("not triggered by Git URLs, images, databases, Compose or templates without Git words", () => {
    for (const text of [
      "import https://github.com/acme/web",
      "create an app from the nginx image",
      "add a redis database service",
      "create a compose service",
      "deploy the blog template app",
      "set up a server",
    ]) {
      expect(intentOf(text)?.flow).not.toBe("git_import");
    }
  });
});

describe("how to run (spec 19.7 step 6)", () => {
  const files = (...paths: string[]) => paths.map((path) => ({ path, type: "file" as const }));

  test("a Dockerfile and a Compose file: both are offered; a package.json alone builds automatically", () => {
    expect(
      runOptions(files("Dockerfile", "docker-compose.yml", "package.json"), []).map((o) => o.kind),
    ).toEqual(["compose", "dockerfile"]);
    expect(runOptions(files("package.json", "src/index.js"), [])).toEqual([
      { kind: "automatic", folder: "", manifest: "package.json" },
    ]);
    expect(runOptions(files("compose.yaml"), [])).toEqual([
      { kind: "compose", path: "compose.yaml" },
    ]);
  });

  test("monorepos list runnable folders, Dockerfile folders first, packages only if they start something", () => {
    const options = runOptions(
      files(
        "package.json",
        "pnpm-workspace.yaml",
        "apps/web/package.json",
        "apps/api/Dockerfile",
        "packages/ui/package.json",
      ),
      [
        { path: "package.json", content: '{"private":true}' },
        { path: "apps/web/package.json", content: '{"scripts":{"start":"next start"}}' },
        { path: "packages/ui/package.json", content: '{"name":"ui"}' },
      ],
    );
    expect(options).toEqual([
      { kind: "dockerfile", folder: "apps/api", dockerfile: "Dockerfile" },
      { kind: "automatic", folder: "apps/web", manifest: "package.json" },
    ]);
  });

  test("a workspace root or index.html is used directly; nothing fits → empty", () => {
    expect(
      runOptions(files("package.json", "packages/ui/package.json"), [
        { path: "package.json", content: '{"workspaces":["packages/*"]}' },
        { path: "packages/ui/package.json", content: '{"name":"ui"}' },
      ]),
    ).toEqual([{ kind: "automatic", folder: "", manifest: "package.json" }]);
    expect(runOptions(files("index.html", "style.css"), [])).toEqual([
      { kind: "static", folder: "" },
    ]);
    expect(runOptions(files("README.md", "docs/guide.md"), [])).toEqual([]);
    expect(describeOption({ kind: "compose", path: "x" })).toBe(
      "Every service in the compose file",
    );
  });

  test("variable names from example env files and schema files", () => {
    expect(namesFromExample("# db\nDATABASE_URL=\nexport SECRET_KEY=change-me\n  \n")).toEqual([
      "DATABASE_URL",
      "SECRET_KEY",
    ]);
    // Read with the variables editor's parser, tolerantly: lines it can't read are skipped,
    // a comment after a quoted value is fine, and a value over several lines adds no names.
    expect(
      namesFromExample(
        [
          `${String.fromCharCode(0xfeff)}APP_NAME=shop`,
          "# OLD_NAME=unused",
          'MAIL_FROM="Shop <shop@example.com>" # sender',
          "see the README for these",
          "=orphan",
          "1BAD=x",
          'PRIVATE_KEY="-----BEGIN KEY-----',
          "INSIDE_THE_KEY=abc",
          '-----END KEY-----"',
          "  export   REDIS_URL = redis://localhost:6379",
          "APP_NAME=again",
        ].join("\r\n"),
      ),
    ).toEqual(["APP_NAME", "MAIL_FROM", "PRIVATE_KEY", "REDIS_URL", "APP_NAME"]);
    expect(namesFromExample("")).toEqual([]);
    expect(variableNames([namesFromExample("A=1\nPORT=3000\nA=2\nB=")], 50)).toEqual(["A", "B"]);
    expect(
      namesFromSchema(
        'const url = process.env.DATABASE_URL;\nconst k = os.getenv("STRIPE_KEY")\nexport const env = z.object({\n  REDIS_URL: z.string(),\n});',
      ),
    ).toEqual(["DATABASE_URL", "STRIPE_KEY", "REDIS_URL"]);
  });
});

describe("reading a failed log (spec 19.7 keep going)", () => {
  test("missing variables from common framework errors", () => {
    expect(missingVariables("Error: DATABASE_URL is not set\n", [])).toEqual(["DATABASE_URL"]);
    expect(
      missingVariables(
        "error: Environment variable not found: DATABASE_URL.\n  -->  schema.prisma:10",
        [],
      ),
    ).toEqual(["DATABASE_URL"]);
    expect(missingVariables("KeyError: 'SECRET_KEY'", [])).toEqual(["SECRET_KEY"]);
    expect(
      missingVariables(
        "❌ Invalid environment variables: { AUTH_SECRET: [ 'Required' ], NEXTAUTH_URL: [ 'Required' ] }",
        [],
      ),
    ).toEqual(["AUTH_SECRET", "NEXTAUTH_URL"]);
    expect(
      missingVariables("Please define the MONGODB_URI environment variable inside .env.local", []),
    ).toEqual(["MONGODB_URI"]);
    expect(missingVariables("PORT is not set; using 3000\nall good", [])).toEqual([]);
  });

  test("connection refused to a database port on localhost, matched against example names", () => {
    const log = "Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap";
    expect(missingVariables(log, ["POSTGRES_URL", "REDIS_URL"])).toEqual(["POSTGRES_URL"]);
    expect(missingVariables(log, [])).toEqual(["DATABASE_URL"]);
    expect(missingVariables("Error: connect ECONNREFUSED ::1:6379", [])).toEqual(["REDIS_URL"]);
  });

  test("missing build tools, build failures and the log's end", () => {
    expect(missingTool("railpack is not installed on the build machine. Run setup again.")).toBe(
      "railpack",
    );
    expect(missingTool("sh: nixpacks: command not found")).toBe("nixpacks");
    expect(missingTool("sh: next: command not found")).toBeNull();
    expect(failedWhileBuilding("Building with Dockerfile\nERROR: failed to solve", null)).toBe(
      true,
    );
    expect(
      failedWhileBuilding("Building with Dockerfile\nBuilt nearzero/web:1\nexited 1", "img"),
    ).toBe(false);
    expect(lastLines("a\nb\nc\n", 2)).toBe("b\nc");
  });
});

describe("pasted links with other words (31d R4-01)", () => {
  const only = (text: string) => {
    const clauses = splitClauses(text) ?? [];
    expect(clauses).toHaveLength(1);
    return intentOf(clauses[0] as string);
  };

  test("the four phrasings run the checked import, with the words that matter honoured", () => {
    expect(only("https://github.com/acme/web.git clone it and deploy this frontend")).toMatchObject(
      { flow: "git_link", link: { host: "github.com", fullName: "acme/web" }, deploy: true },
    );
    expect(only("deploy https://github.com/acme/web with its Dockerfile")).toMatchObject({
      flow: "git_link",
      builder: "dockerfile",
      name: null,
    });
    expect(
      only("please deploy this repo https://github.com/acme/web, it is a next.js app"),
    ).toMatchObject({ flow: "git_link", builder: null });
    expect(only("import gitlab.com/acme/api as api")).toMatchObject({
      flow: "git_link",
      link: { host: "gitlab.com", fullName: "acme/api" },
      name: "api",
    });
    expect(only("clone and deploy https://github.com/acme/web on prod-1")).toMatchObject({
      flow: "git_link",
      server: "prod-1",
    });
  });

  test("no length limit when the message is all about the link", () => {
    const long = `deploy https://github.com/acme/web. ${"It is our marketing site, built with next.js and tailwind, and it has been running on another host for a while. ".repeat(5)}`;
    expect(long.length).toBeGreaterThan(400);
    expect(only(long)).toMatchObject({ flow: "git_link" });
  });

  test("questions, other requests and details the import can't honour go to the model", () => {
    for (const text of [
      "what does github.com/acme/web do?",
      "fork github.com/acme/web and rewrite it in rust",
      "deploy https://github.com/acme/web with build command npm run build",
      "deploy https://github.com/acme/web on port 8080",
      "deploy https://github.com/acme/web to production",
      "deploy https://github.com/acme/web with a postgres database",
      "deploy https://github.com/acme/web with nixpacks and its Dockerfile",
      "deploy https://github.com/acme/web from the ../secrets folder",
    ]) {
      const clauses = splitClauses(text) ?? [];
      expect(clauses.length === 0 ? null : intentOf(clauses[0] as string)).toBeNull();
    }
    // Another request after the link stays its own clause.
    expect(intents("deploy https://github.com/acme/web and then delete project old")).toEqual([
      expect.objectContaining({ flow: "git_link" }),
      expect.objectContaining({ flow: "delete_project", names: ["old"] }),
    ]);
  });
});

describe("a builder, folder or name in a short import request (31d G4-06)", () => {
  test("is read, never dropped", () => {
    expect(intentOf("import acme/web with nixpacks")).toMatchObject({
      flow: "git_import",
      repository: "acme/web",
      builder: "nixpacks",
      folder: null,
    });
    expect(intentOf("deploy acme/web from the apps/api folder")).toMatchObject({
      flow: "git_import",
      repository: "acme/web",
      folder: "apps/api",
      builder: null,
    });
    expect(intentOf("import acme/web using the static builder")).toMatchObject({
      repository: "acme/web",
      builder: "static",
    });
    expect(intentOf("import acme/web as storefront")).toMatchObject({
      repository: "acme/web",
      name: "storefront",
    });
    expect(intentOf("import acme/web with heroku buildpacks in folder ./apps/web/")).toMatchObject({
      builder: "heroku",
      folder: "apps/web",
    });
  });

  test("a detail the guided import can't honour sends the request to the model", () => {
    expect(intentOf("import acme/web with nixpacks and railpack")).toBeNull();
    expect(intentOf("import acme/web with start command node server.js")).toBeNull();
    expect(intentOf("import acme/web with buildpacks")).toBeNull();
  });
});
