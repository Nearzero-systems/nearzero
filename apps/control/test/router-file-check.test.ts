import { describe, expect, test } from "bun:test";
import { isManagedRouterFile, ROUTER_FILE_MESSAGES, routerFileNameProblem } from "@nearzero/shared";
import { checkRouterFile, describeRouterFileProblem } from "../src/routing/router-file-check.ts";

/** Settings → Router files validates YAML and the router's schema before saving (spec 18.3). */

const reason = (contents: string) => {
  const problem = checkRouterFile(contents);
  return problem ? describeRouterFileProblem(problem) : null;
};

describe("router file check (spec 18.3)", () => {
  test("accepts the router's own kinds of configuration, and an empty file", () => {
    expect(reason("")).toBeNull();
    expect(reason("# nothing yet\n")).toBeNull();
    expect(
      reason(`http:
  routers:
    blog:
      rule: "Host(\`blog.example.com\`)"
      entryPoints: [websecure]
      service: blog
      middlewares: [strip]
      priority: 10
      tls:
        certResolver: letsencrypt
  services:
    blog:
      loadBalancer:
        passHostHeader: true
        servers:
          - url: "http://10.0.0.5:8080"
    split:
      weighted:
        services: [{ name: blog, weight: 1 }]
  middlewares:
    strip:
      stripPrefix:
        prefixes: ["/blog"]
tcp:
  routers:
    db:
      rule: "HostSNI(\`*\`)"
      service: db
  services:
    db:
      loadBalancer:
        servers:
          - address: "10.0.0.6:5432"
tls:
  certificates:
    - certFile: /certs/a.crt
      keyFile: /certs/a.key
`),
    ).toBeNull();
  });

  test("invalid YAML is refused with its line", () => {
    expect(reason("http:\n  routers:\n    web:\n      rule: [unclosed\n")).toMatch(
      /^Line \d+: This isn't valid YAML: /,
    );
    expect(reason("http:\n  routers: {}\n  routers: {}\n")).toMatch(
      /^Line 3: This isn't valid YAML: Map keys must be unique/,
    );
  });

  test("schema problems name the line and the reason", () => {
    expect(reason("htp:\n  routers: {}\n")).toBe(
      'Line 1: Unknown section "htp". A router file has http, tcp, udp or tls.',
    );
    expect(reason("http:\n  routers:\n    web:\n      service: web\n")).toBe(
      'Line 3: "http.routers.web" needs a rule.',
    );
    expect(
      reason(
        "http:\n  routers:\n    web:\n      rule: Host(`a.b`)\n      service: web\n      entrypoints: [web]\n",
      ),
    ).toBe(
      'Line 6: Unknown setting "entrypoints" in "http.routers.web". Expected rule, ruleSyntax, service, entryPoints, middlewares, priority, tls or observability.',
    );
    expect(
      reason(
        "http:\n  routers:\n    web:\n      rule: x\n      service: web\n      entryPoints: websecure\n",
      ),
    ).toBe('Line 6: "http.routers.web.entryPoints" must be a list of names.');
    expect(reason("http:\n  services:\n    web:\n      passHostHeader: true\n")).toBe(
      'Line 4: Unknown setting "passHostHeader" in "http.services.web". Expected loadBalancer, weighted, mirroring or failover.',
    );
    expect(
      reason(
        "http:\n  services:\n    web:\n      loadBalancer:\n        servers:\n          - address: x\n",
      ),
    ).toBe(
      'Line 6: Unknown setting "address" in "http.services.web.loadBalancer.servers[0]". Expected url, weight or preservePath.',
    );
    expect(
      reason("http:\n  middlewares:\n    https:\n      redirectHttps:\n        permanent: true\n"),
    ).toBe('Line 4: "http.middlewares.https" uses an unknown middleware type "redirectHttps".');
    expect(reason("http:\n  routers:\n    web:\n")).toBe(
      'Line 3: "http.routers.web" has no settings.',
    );
    expect(reason("- just\n- a list\n")).toBe('Line 1: "the file" must be a map of settings.');
  });

  test("file names: directly in the folder, YAML, never the runner's own files", () => {
    expect(routerFileNameProblem("my-redirects.yml")).toBeNull();
    expect(routerFileNameProblem("console.yaml")).toBeNull();
    expect(routerFileNameProblem("../etc/passwd.yml")).toBe(
      "Router files live directly in the router's folder. Paths outside it are refused.",
    );
    expect(routerFileNameProblem("certificates/a.yml")).toContain("Paths outside it are refused");
    expect(routerFileNameProblem(".hidden.yml")).toContain("Paths outside it are refused");
    expect(routerFileNameProblem("rules.toml")).toContain("ending in .yml or .yaml");
    expect(routerFileNameProblem("route-web.yml")).toBe(ROUTER_FILE_MESSAGES.managed);
    expect(isManagedRouterFile("nearzero-certificates.yml")).toBe(true);
    expect(isManagedRouterFile("console.yml")).toBe(false);
  });
});
