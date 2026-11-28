// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Compose's own ${NAME} syntax.
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import {
  COMPOSE_INTERPOLATION_MAX_CHARS,
  composeInventory,
  InterpolationTooLarge,
  interpolate,
  interpolateModel,
  type Model,
  missingVariables,
  parseComposeFile,
  publishedPorts,
  startOrder,
} from "../src/compose-runtime/model.ts";
import { planStack, webService } from "../src/compose-runtime/plan.ts";
import { findPrivileged, placeOf } from "../src/compose-runtime/privileged.ts";
import {
  builtImage,
  renderAdditions,
  renderEnvFile,
  reservedPortProblems,
} from "../src/compose-runtime/render.ts";
import { cleanComposePath, composeSourceOf, folderOf } from "../src/compose-runtime/source.ts";

/**
 * The Compose runtime's pure rules (spec 07, 05 5.5, 24 G3): reading a file, its inventory,
 * Compose's interpolation, privileged options, Nearzero's additions and the env file.
 */

function model(text: string): Model {
  const parsed = parseComposeFile(text);
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.model;
}

const RAW = { projectDirectory: "", root: "", appName: "shop-a1b2c3" };
const none = () => undefined;

describe("reading a Compose file", () => {
  test("broken YAML names the line", () => {
    const parsed = parseComposeFile("services:\n  web:\n    image: [nginx\n");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toMatch(/^It isn't valid YAML: line \d+, column \d+/);
  });

  test("the shape Compose needs", () => {
    const problem = (text: string) => {
      const parsed = parseComposeFile(text);
      return parsed.ok ? null : parsed.problem;
    };
    expect(problem("")).toBe("The Compose file is empty.");
    expect(problem("- a\n- b\n")).toBe(
      "A Compose file is a map with a services: section at the top.",
    );
    expect(problem("version: '3'\n")).toBe("The Compose file has no services: section.");
    expect(problem("services: {}\n")).toBe("The Compose file has no services.");
    expect(problem("services:\n  web:\n    ports: ['80']\n")).toBe(
      "The service web needs an image: or a build: to run.",
    );
    expect(problem("services:\n  'bad name':\n    image: x\n")).toMatch(/can't be a service name/);
    expect(problem("services:\n  web:\n    image: a\n  web:\n    image: b\n")).toMatch(/unique/);
    expect(problem("services:\n  web:\n    image: nginx\n")).toBeNull();
  });

  test("merge keys and Compose's own tags are read", () => {
    const parsed = parseComposeFile(
      "x-common: &common\n  restart: always\nservices:\n  web:\n    <<: *common\n    image: nginx\n    container_name: !reset null\n",
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect((parsed.model.services as Model).web).toMatchObject({
        restart: "always",
        image: "nginx",
      });
      expect(parsed.warnings).toEqual([]);
    }
  });

  test("the inventory: ports, builds, dependencies and volumes by Docker's names", () => {
    const inventory = composeInventory(
      model(`services:
  web:
    build: ./app
    expose: ["3000"]
    depends_on: [db]
    volumes: ["static:/srv"]
  db:
    image: postgres:17
    ports: ["127.0.0.1:5433:5432/tcp"]
    volumes: ["pg:/var/lib/postgresql/data", "./init:/docker-entrypoint-initdb.d"]
  worker:
    image: busybox
    network_mode: host
    depends_on:
      db: { condition: service_healthy }
volumes:
  pg: {}
  static: { name: shop-a1b2c3-static }
  shared: { external: true }
`),
      "shop-a1b2c3",
    );
    expect(inventory.services).toEqual([
      {
        name: "web",
        port: 3000,
        published: [],
        image: null,
        build: true,
        dependsOn: ["db"],
        networkMode: null,
      },
      {
        name: "db",
        port: 5432,
        published: [{ port: 5433, protocol: "tcp" }],
        image: "postgres:17",
        build: false,
        dependsOn: [],
        networkMode: null,
      },
      {
        name: "worker",
        port: null,
        published: [],
        image: "busybox",
        build: false,
        dependsOn: ["db"],
        networkMode: "host",
      },
    ]);
    expect(inventory.volumes).toEqual([
      { key: "pg", name: "shop-a1b2c3_pg", external: false, innerServices: ["db"] },
      { key: "static", name: "shop-a1b2c3-static", external: false, innerServices: ["web"] },
      { key: "shared", name: "shared", external: true, innerServices: [] },
    ]);
    expect(startOrder(inventory.services)).toEqual(["db", "web", "worker"]);
    expect(webService(inventory.services)?.name).toBe("web");
  });
});

describe("published ports (B1-29)", () => {
  test("every form of ports: names the server ports it takes", () => {
    expect(
      [
        "8080:80",
        "127.0.0.1:5433:5432/tcp",
        "[::1]:9000:9000",
        "53:53/udp",
        "9100-9102:9100-9102",
        "3000",
        3001,
        { target: 80, published: 8081 },
        { target: 80, published: "8090-8091", protocol: "udp" },
        { target: 80 },
        "${PORT}:80",
      ].map(publishedPorts),
    ).toEqual([
      [{ port: 8080, protocol: "tcp" }],
      [{ port: 5433, protocol: "tcp" }],
      [{ port: 9000, protocol: "tcp" }],
      [{ port: 53, protocol: "udp" }],
      [
        { port: 9100, protocol: "tcp" },
        { port: 9101, protocol: "tcp" },
        { port: 9102, protocol: "tcp" },
      ],
      [],
      [],
      [{ port: 8081, protocol: "tcp" }],
      [
        { port: 8090, protocol: "udp" },
        { port: 8091, protocol: "udp" },
      ],
      [],
      [],
    ]);
  });
});

describe("Compose's interpolation", () => {
  const values = new Map([
    ["A", "one"],
    ["EMPTY", ""],
  ]);
  const lookup = (name: string) => values.get(name);
  test("every form", () => {
    expect(interpolate("${A}/$A/$$A", lookup)).toBe("one/one/$A");
    expect(interpolate("${MISSING:-dflt} ${EMPTY:-dflt} ${EMPTY-dflt}", lookup)).toBe("dflt dflt ");
    expect(interpolate("${A:+set} ${MISSING:+set} ${EMPTY+x}", lookup)).toBe("set  x");
    expect(interpolate("${MISSING:-${A}}", lookup)).toBe("one");
    expect(interpolate("cost: $5 and $", lookup)).toBe("cost: $5 and $");
  });

  test("variables the file needs and doesn't have", () => {
    const file = model(`services:
  db:
    image: postgres
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_USER: \${POSTGRES_USER:-postgres}
      TZ: $TZ
x-unused: \${NOT_COUNTED}
`);
    expect(missingVariables(file, new Set())).toEqual(["POSTGRES_PASSWORD", "TZ"]);
    expect(missingVariables(file, new Set(["POSTGRES_PASSWORD", "TZ"]))).toEqual([]);
  });

  test("a file can't multiply a capped variable without limit (C1-03)", () => {
    // The report's file: a 200 KB variable used 500 times in 2 KB of Compose file.
    const big = "x".repeat(200 * 1024);
    const file = `services:\n  web:\n    image: nginx\n    command: "${"${A}".repeat(500)}"\n`;
    const planned = planStack({
      file,
      source: { type: "raw", composeFile: file },
      appName: "shop-a1b2c3",
      serviceId: "s",
      deploymentId: null,
      variables: [{ name: "A", value: big }],
      routes: [],
      onHost: true,
    });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.problem).toBe(
      "It grows past 8 MB once its variables are filled in, mostly from A. Use A fewer times, or make it shorter.",
    );
    // A value from the repository's .env (checkValues) is counted the same way.
    const fromEnv = planStack({
      file,
      source: { type: "raw", composeFile: file },
      appName: "shop-a1b2c3",
      serviceId: "s",
      deploymentId: null,
      variables: [],
      checkValues: { A: big },
      routes: [],
      onHost: false,
    });
    expect(fromEnv.ok).toBe(false);
    // Defaults count too, and the budget covers the whole model, not each string alone.
    const values = new Map([["B", "y".repeat(1024 * 1024)]]);
    const spread = { a: "${B}${B}${B}", b: ["${B}${B}${B}", "${X:-${B}${B}}"], c: "${B}" };
    expect(() => interpolateModel(spread, (name) => values.get(name))).toThrow(
      InterpolationTooLarge,
    );
    // A large alias repeated many times without any variable stops too.
    const aliased = `x-big: &big "${"z".repeat(64 * 1024)}"\nservices:\n  web:\n    image: nginx\n    environment:\n${Array.from({ length: 200 }, (_, i) => `      V${i}: *big`).join("\n")}\n`;
    const aliasPlan = planStack({
      file: aliased,
      source: { type: "raw", composeFile: aliased },
      appName: "shop-a1b2c3",
      serviceId: "s",
      deploymentId: null,
      variables: [],
      routes: [],
      onHost: false,
    });
    expect(aliasPlan.ok).toBe(false);
    if (!aliasPlan.ok) expect(aliasPlan.problem).toContain("Repeat large values fewer times.");
    // An honest file with a large value used a few times is fine.
    const honest = `services:\n  web:\n    image: nginx\n    environment:\n      CERT: \${A}\n      COPY: \${A}\n`;
    const ok = planStack({
      file: honest,
      source: { type: "raw", composeFile: honest },
      appName: "shop-a1b2c3",
      serviceId: "s",
      deploymentId: null,
      variables: [{ name: "A", value: "c".repeat(256 * 1024) }],
      routes: [],
      onHost: false,
    });
    expect(ok.ok).toBe(true);
    expect(COMPOSE_INTERPOLATION_MAX_CHARS).toBe(8 * 1024 * 1024);
  });

  test("placeholders are reported once however often they repeat", () => {
    const seen: { name: string; optional: boolean }[] = [];
    interpolate("${A}${A}$A${A:-x}${A:-y}", () => undefined, seen);
    expect(seen).toEqual([
      { name: "A", optional: false },
      { name: "A", optional: true },
    ]);
  });
});

describe("privileged options (spec 07 7.3, 24 G3)", () => {
  const kinds = (text: string, lookup: (name: string) => string | undefined = none, folder = RAW) =>
    findPrivileged(model(text), folder, lookup).map(
      (finding) => `${finding.service ?? "*"}:${finding.kind}`,
    );

  test("a plain stack has none", () => {
    expect(
      kinds(`services:
  web:
    image: nginx
    ports: ["8080:80"]
    cap_add: [NET_BIND_SERVICE, CHOWN]
    volumes: ["./html:/usr/share/nginx/html:ro", "data:/data", "./conf/nginx.conf:/etc/nginx/nginx.conf"]
    env_file: [.env, ./config/app.env]
    build: { context: ., dockerfile: docker/Dockerfile }
    security_opt: ["no-new-privileges:true"]
volumes:
  data: {}
networks:
  back: {}
  edge: { external: true, name: nearzero-edge }
`),
    ).toEqual([]);
  });

  test("each kind is found", () => {
    expect(
      kinds(`services:
  a:
    image: x
    network_mode: host
    privileged: "yes"
    cap_add: [SYS_ADMIN, NET_ADMIN]
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /etc:/host-etc:ro
      - ../outside:/x
      - ~/.ssh:/ssh
      - type: bind
        source: /srv
        target: /srv
  b:
    image: x
    pid: host
    devices: ["/dev/sda:/dev/sda"]
    security_opt: ["seccomp:unconfined"]
    volumes_from: ["container:nearzero-runner"]
    env_file: /etc/environment
    build:
      context: /
      network: host
volumes:
  v: { external: true }
  w: { driver_opts: { type: none, o: bind, device: /var/lib } }
networks:
  n: { external: true, name: nearzero-internal }
secrets:
  s: { file: /root/.ssh/id_rsa }
`),
    ).toEqual([
      "a:host-network",
      "a:privileged",
      "a:capabilities",
      "a:docker-socket",
      "a:host-path",
      "a:host-path",
      "a:host-path",
      "a:host-path",
      "b:host-namespace",
      "b:devices",
      "b:security-options",
      "b:shared-resource",
      "b:host-path",
      "b:host-path",
      "b:host-network",
      "*:shared-resource",
      "*:host-path",
      "*:shared-resource",
      "*:host-path",
    ]);
  });

  test("paths are checked where variables make them point", () => {
    const file = `services:\n  a:\n    image: x\n    volumes: ["\${DATA}:/data"]\n`;
    expect(kinds(file, (name) => (name === "DATA" ? "./data" : undefined))).toEqual([]);
    expect(kinds(file, (name) => (name === "DATA" ? "/srv/data" : undefined))).toEqual([
      "a:host-path",
    ]);
    // A variable that isn't set can't be checked: it counts as outside.
    const unset = findPrivileged(model(file), RAW, none);
    expect(unset[0]?.message).toContain("a variable that isn't set");
  });

  test("a repository may reach its own root, never past it", () => {
    const folder = {
      ...folderOf({
        type: "git",
        url: "x",
        branch: "main",
        composePath: "deploy/compose.yml",
        sshKeyId: null,
        submodules: false,
      }),
      appName: "shop-a1b2c3",
    };
    expect(folder).toMatchObject({ projectDirectory: "repo/deploy", root: "repo" });
    expect(placeOf("../config", folder)).toEqual({ inside: true, path: "repo/config" });
    expect(placeOf("../../.nearzero/env", folder).inside).toBe(false);
    expect(placeOf("./data", RAW)).toEqual({ inside: true, path: "data" });
    expect(placeOf("data/../../x", RAW).inside).toBe(false);
  });

  test("findings have stable keys for an administrator's approval", () => {
    const text = "services:\n  a:\n    image: x\n    privileged: true\n  b:\n    image: y\n";
    const keys = (file: string, folder = RAW) =>
      findPrivileged(model(file), folder, none).map((item) => item.key);
    const first = keys(text);
    expect(first).toHaveLength(1);
    expect(first[0]).toStartWith("a|privileged|privileged@");
    // The same file gives the same key, and so does a change to another service.
    expect(keys(text)).toEqual(first);
    expect(keys(text.replace("image: y", "image: z"))).toEqual(first);
  });

  test("an approval covers the whole definition, not the option alone (B1-06)", () => {
    const keys = (file: string, folder = RAW) =>
      findPrivileged(model(file), folder, none).map((item) => item.key);
    // The report's attack: the approved socket service gets another image and command.
    const approved = `services:
  agent:
    image: portainer/agent:2
    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
`;
    const changed = `services:
  agent:
    image: alpine
    command: ["sh", "-c", "docker run --privileged -v /:/host alpine"]
    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
`;
    expect(keys(approved)[0]).toStartWith("agent|docker-socket|socket:/var/run/docker.sock@");
    expect(keys(changed)).not.toEqual(keys(approved));
    expect(keys(`${approved}    restart: always\n`)).not.toEqual(keys(approved));
    // An image or command can come from a service it extends in the same file.
    const base = (image: string) => `services:
  base:
    image: ${image}
  agent:
    extends: base
    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
`;
    expect(keys(base("portainer/agent:2"))).not.toEqual(keys(base("alpine")));
    // The same file from another repository builds other code.
    const repo = (url: string) => ({
      projectDirectory: "repo",
      root: "repo",
      appName: "shop-a1b2c3",
      origin: `git:${url}#main:compose.yml`,
    });
    expect(keys(approved, repo("https://a.example/x.git"))).not.toEqual(
      keys(approved, repo("https://b.example/x.git")),
    );
    // A new service that borrows the approved one's mounts reaches the socket too.
    const borrower = `${approved}  evil:
    image: alpine
    volumes_from: [agent]
`;
    const found = findPrivileged(model(borrower), RAW, none);
    expect(found.map((item) => `${item.service}:${item.kind}`)).toEqual([
      "agent:docker-socket",
      "evil:docker-socket",
    ]);
    const shared = findPrivileged(
      model(`services:
  a:
    image: x
    network_mode: host
  b:
    image: y
    network_mode: service:a
`),
      RAW,
      none,
    );
    expect(shared.map((item) => `${item.service}:${item.kind}`)).toEqual([
      "a:host-network",
      "b:host-network",
    ]);
    // A top-level server folder is tied to the services that mount it.
    const volume = `services:
  a:
    image: x
    volumes: ["w:/w"]
volumes:
  w: { driver_opts: { type: none, o: bind, device: /var/lib } }
`;
    const withNewUser = volume.replace(
      "volumes:\n  w:",
      '  b:\n    image: alpine\n    volumes: ["w:/w"]\nvolumes:\n  w:',
    );
    expect(keys(volume)).toHaveLength(1);
    expect(keys(withNewUser)).toHaveLength(1);
    expect(keys(withNewUser)).not.toEqual(keys(volume));
  });

  test("other Compose files are findings no approval covers (B1-01)", () => {
    const of = (text: string) =>
      findPrivileged(model(text), RAW, none).map((item) => ({
        what: `${item.service ?? "*"}:${item.kind}`,
        approvable: item.approvable,
      }));
    // The report's attack: a harmless main file that includes the privileged one.
    expect(of("include: [./more.yml]\nservices:\n  web:\n    image: nginx\n")).toEqual([
      { what: "*:other-files", approvable: false },
    ]);
    // A pasted file that includes something a container wrote into its own folder.
    expect(
      of(`include:
  - path: ./data/x.yml
services:
  writer:
    image: alpine
    volumes: ["./data:/data"]
`),
    ).toEqual([{ what: "*:other-files", approvable: false }]);
    expect(
      of(`services:
  web:
    extends: { file: ./base.yml, service: web }
`),
    ).toEqual([{ what: "web:other-files", approvable: false }]);
    // Extending a service of the same file reads nothing else.
    expect(
      of("services:\n  base:\n    image: x\n  web:\n    extends: { service: base }\n"),
    ).toEqual([]);
  });

  test("variables Compose takes from the runner are checked as Compose sees them (B1-32)", () => {
    const file = `services:\n  a:\n    image: x\n    volumes: ["\${HOME}/x:/x"]\n`;
    // The service's own HOME says ./ but Compose uses the runner's home folder.
    const found = findPrivileged(model(file), RAW, (name) => (name === "HOME" ? "." : undefined));
    expect(found.map((item) => item.kind)).toEqual(["host-path"]);
    expect(found[0]?.message).toContain("the runner's HOME folder");
    // The stack's folder as Compose sees it stays inside, and can't reach above a repository.
    const inside = `services:\n  a:\n    image: x\n    volumes: ["\${NEARZERO_SERVICE_FOLDER}/data:/d"]\n`;
    expect(findPrivileged(model(inside), RAW, none)).toEqual([]);
    const repo = { projectDirectory: "repo/deploy", root: "repo", appName: "shop-a1b2c3" };
    expect(findPrivileged(model(inside), repo, none).map((item) => item.kind)).toEqual([
      "host-path",
    ]);
    // A plan never reports them missing: Compose always has them.
    const planned = planStack({
      file,
      source: { type: "raw", composeFile: file },
      appName: "shop-a1b2c3",
      serviceId: "s",
      deploymentId: null,
      variables: [{ name: "HOME", value: "." }],
      routes: [],
      onHost: true,
    });
    if (!planned.ok) throw new Error(planned.problem);
    expect(planned.plan.missing).toEqual([]);
    expect(planned.plan.findings.map((item) => item.kind)).toEqual(["host-path"]);
  });
});

describe("the files Nearzero runs (spec 07 7.3, 05 5.5)", () => {
  test("the additions say only inner services with a hostname join the shared network (R2-11)", () => {
    const file = model("services:\n  web:\n    image: nginx\n  redis:\n    image: redis\n");
    const render = (routes: { composeService: string; url: string; port: number }[]) =>
      renderAdditions({
        model: file,
        resolved: file,
        inventory: composeInventory(file, "shop-a1b2c3"),
        folder: RAW,
        serviceId: "11111111-2222-3333-4444-555555555555",
        deploymentId: null,
        routes,
      }).text;
    const routed = render([{ composeService: "web", url: "https://shop.example.com", port: 80 }]);
    expect(routed).not.toContain("every container");
    expect(routed).toContain(
      "# - Only inner services with a hostname join the shared private network nearzero-edge\n#   (here web, as shop-a1b2c3-<service>), the address the router sends their\n#   hostnames to.\n#   redis stays on the stack's own network.",
    );
    const none = render([]);
    expect(none).toContain(
      "None has one yet, so every service stays on the stack's own network; one that gets a",
    );
  });

  const text = `services:
  web:
    build: ./app
    container_name: my-web
    labels: ["team=shop"]
    volumes:
      - ./data:/data:ro
      - cache:/cache
      - type: bind
        source: ./conf
        target: /etc/conf
      - \${LOGS:-./logs}:/logs
    environment:
      SECRET: \${SECRET}
  db:
    image: postgres
    volumes: ["pg:/var/lib/postgresql/data"]
volumes:
  pg: {}
  cache: {}
  outside: { external: true }
configs:
  site: { file: ./site.conf }
`;

  test("additions: labels, no container_name, per-deployment build tags, the folder, volume labels", () => {
    const parsed = model(text);
    const values = new Map([["SECRET", "hunter2-very-secret"]]);
    const additions = renderAdditions({
      model: parsed,
      resolved: interpolateModel(parsed, (name) => values.get(name)) as Model,
      inventory: composeInventory(parsed, "shop-a1b2c3"),
      folder: RAW,
      serviceId: "11111111-2222-3333-4444-555555555555",
      deploymentId: "abcdef01-0000-0000-0000-000000000000",
      routes: [{ composeService: "web", url: "https://shop.example.com", port: 3000 }],
    });
    expect(additions.text).not.toContain("hunter2");
    expect(additions.text).toContain("container_name: !reset null");
    expect(additions.text).toContain("volumes: !override");
    const merged = parse(additions.text.replaceAll("!reset", "").replaceAll("!override", ""));
    expect(merged.services.web.labels).toEqual({
      "dev.nearzero.managed": "true",
      // 1.0's mark on everything it creates (spec 29.5).
      "dev.nearzero.edition": "1",
      "dev.nearzero.service": "11111111-2222-3333-4444-555555555555",
      "dev.nearzero.deployment": "abcdef01-0000-0000-0000-000000000000",
      "dev.nearzero.compose-service": "web",
      "dev.nearzero.route.hostnames": "https://shop.example.com",
      "dev.nearzero.route.port": "3000",
    });
    expect(merged.services.web.image).toBe("nearzero/shop-a1b2c3-web:abcdef01");
    expect(merged.services.web.volumes).toEqual([
      "${NEARZERO_SERVICE_FOLDER}/data:/data:ro",
      "cache:/cache",
      { type: "bind", source: "${NEARZERO_SERVICE_FOLDER}/conf", target: "/etc/conf" },
      "${LOGS:-./logs}:/logs",
    ]);
    expect(merged.services.db.volumes).toBeUndefined();
    expect(merged.services.db.container_name).toBeUndefined();
    expect(Object.keys(merged.volumes)).toEqual(["pg", "cache"]);
    expect(merged.configs).toEqual({ site: { file: "${NEARZERO_SERVICE_FOLDER}/site.conf" } });
    expect(additions.bindPaths).toEqual(["conf", "data", "logs"]);
    expect(builtImage("shop-a1b2c3", "Web_App", "abcdef0123")).toBe(
      "nearzero/shop-a1b2c3-web_app:abcdef01",
    );
  });

  test("the env file reads back exactly what was saved", () => {
    const file = renderEnvFile([
      { name: "PLAIN", value: "hello" },
      { name: "TRICKY", value: `it's "q" \\n $HOME $$ \\` },
    ]);
    expect(file.split("\n").slice(1)).toEqual([
      'PLAIN="hello"',
      `TRICKY="it's \\"q\\" \\\\n $$HOME $$$$ \\\\"`,
      "",
    ]);
  });

  test("ports Nearzero needs are refused", () => {
    const file = model(
      'services:\n  a:\n    image: x\n    ports: ["80:80", "8080:8080", "3000:3000", {published: "443", target: 443}]\n',
    );
    expect(reservedPortProblems(file, false)).toEqual([
      "a: Port 80 is used by Nearzero on this server. Pick another.",
      "a: Port 443 is used by Nearzero on this server. Pick another.",
    ]);
    expect(reservedPortProblems(file, true)).toContain(
      "a: Port 3000 is used by Nearzero on this server. Pick another.",
    );
  });

  test("a plan names missing variables and keeps values out of the additions", () => {
    const planned = planStack({
      file: text,
      source: { type: "raw", composeFile: text },
      appName: "shop-a1b2c3",
      serviceId: "s",
      deploymentId: null,
      variables: [{ name: "OTHER", value: "x" }],
      routes: [],
      onHost: false,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.missing).toEqual(["SECRET"]);
    expect(planned.plan.uses).toEqual(["LOGS", "SECRET"]);
    expect(planned.plan.envFile).toContain('OTHER="x"');
    expect(planned.plan.additions.text).toContain("<this deployment's id>");
  });

  test("APP_NAME and COMPOSE_PROJECT_NAME are the app name unless variables say otherwise (R2-12)", () => {
    const file =
      'services:\n  web:\n    image: nginx\n    labels: ["owner=${APP_NAME}", "p=${COMPOSE_PROJECT_NAME}"]\n';
    const plan = (variables: { name: string; value: string }[]) => {
      const planned = planStack({
        file,
        source: { type: "raw", composeFile: file },
        appName: "shop-a1b2c3",
        serviceId: "s",
        deploymentId: null,
        variables,
        routes: [],
        onHost: false,
      });
      if (!planned.ok) throw new Error(planned.problem);
      return planned.plan;
    };
    const plain = plan([]);
    expect(plain.missing).toEqual([]);
    expect(plain.envFile).toContain('APP_NAME="shop-a1b2c3"');
    expect(plain.envFile).toContain('COMPOSE_PROJECT_NAME="shop-a1b2c3"');
    expect((plain.resolved.services as Record<string, { labels: string[] }>).web?.labels).toEqual([
      "owner=shop-a1b2c3",
      "p=shop-a1b2c3",
    ]);
    // The service's own APP_NAME wins, and appears once.
    const own = plan([{ name: "APP_NAME", value: "storefront" }]);
    expect(own.envFile.match(/^APP_NAME=/gm)?.length).toBe(1);
    expect(own.envFile).toContain('APP_NAME="storefront"');
    expect(own.envFile).not.toContain('APP_NAME="shop-a1b2c3"');
  });

  test("sources", () => {
    expect(composeSourceOf({ source: { type: "raw", composeFile: "  " } })).toBeNull();
    expect(composeSourceOf({ source: { type: "raw", composeFile: "services: {}" } })?.type).toBe(
      "raw",
    );
    expect(cleanComposePath("./deploy/compose.yml")).toBe("deploy/compose.yml");
    expect(cleanComposePath("")).toBe("docker-compose.yml");
  });
});
