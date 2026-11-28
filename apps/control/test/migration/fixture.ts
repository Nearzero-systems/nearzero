import { createHash, randomBytes, scryptSync } from "node:crypto";
import type { BundleContent } from "../../src/migration/bundle.ts";
import { generateKeyPair } from "../../src/ssh-keys/format.ts";
import { selfSigned } from "./support.ts";

/**
 * A rich export bundle written the way the final 0.1.x release writes one, field by field as spec
 * 29a fixes it: two workspaces, members with policies, apps from a GitHub App, a Git URL and an
 * image, a Compose stack, all six databases, generated and own hostnames, a remote server,
 * backups, tasks, channels, Agent sessions and deployments. Built from the spec alone.
 */

export const PASSWORDS = {
  alice: "alice-old-password",
  bob: "bob-old-password",
  carol: "carol-old-pässword",
} as const;

/** The TOTP key as text (29a.5.1: the HMAC key is its UTF-8 bytes), RFC 6238's test key. */
export const TOTP_TEXT = "12345678901234567890";
export const TOTP_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
/** A backup code exactly as 0.1.x showed it. */
export const BACKUP_CODE = "Q7RT-29XZ";
export const WEBHOOK_TOKEN = "old-webhook-secret-0123456789abcdef";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** scrypt as a PHC string ($scrypt$ln=…,r=…,p=…$salt$key). */
export function scryptPhc(password: string, log2n = 14): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N: 2 ** log2n, r: 8, p: 1 });
  return `$scrypt$ln=${log2n},r=8,p=1$${salt.toString("base64").replace(/=+$/, "")}$${key.toString("base64").replace(/=+$/, "")}`;
}

/** scrypt as spec 29a.5.1 declares it: NFKC password, the salt's hex text used as UTF-8 bytes. */
export function scryptDeclared(password: string): {
  algorithm: "scrypt";
  encoded: string;
  params: Record<string, unknown>;
} {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(password.normalize("NFKC"), salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  }).toString("hex");
  return {
    algorithm: "scrypt",
    encoded: `${salt}:${key}`,
    params: {
      N: 16384,
      r: 16,
      p: 1,
      keyLength: 64,
      salt,
      saltEncoding: "utf8",
      key,
      keyEncoding: "hex",
      passwordNormalization: "NFKC",
    },
  };
}

const NO_SCOPE = {
  allProjects: false,
  projectRefs: [],
  environmentRefs: [],
  serviceRefs: [],
  allServers: false,
  serverRefs: [],
  allGitProviders: false,
  gitProviderRefs: [],
};

export interface RichFixture {
  content: BundleContent;
  serverRef: string;
}

export async function richFixture(): Promise<RichFixture> {
  const key = await generateKeyPair("ed25519", "deploy");
  const uploaded = await selfSigned(["shop.example.org"]);
  const issuedHost = await selfSigned(["api.apps.example.com"]);
  const issuedServer = await selfSigned(["a1b2c3.prod1.apps.example.com"]);
  const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
  const t = (days: number) => new Date(Date.UTC(2026, 5, 1) + days * 86_400_000).toISOString();
  const bcrypt = await Bun.password.hash(PASSWORDS.bob, { algorithm: "bcrypt", cost: 4 });
  const policiesOn = {
    "Create projects": true,
    "Rename and describe projects": true,
    "Delete projects without production": false,
    "Create and configure services": true,
    "Import from Git": true,
    "Assign domains": true,
    "Deploy and run services": true,
    "Create and run tasks": false,
    "Add SSH keys": true,
    "Read SSH keys": false,
    "Rename SSH keys": false,
    "Delete SSH keys": false,
    "Add and set up servers": true,
    "Remove servers": false,
    "Ask for the OpenRouter key in chat": true,
    "Change production environments": false,
  };
  const person = (fields: Record<string, unknown>) => ({
    emailVerified: true,
    lastName: "",
    twoFactor: null,
    avatar: null,
    otherSignIns: [],
    banned: false,
    createdAt: null,
    ...fields,
  });

  const records: BundleContent["records"] = {
    "people.jsonl": [
      person({
        ref: "per_alice",
        email: "Alice@Example.com",
        firstName: "Alice",
        lastName: "Ng",
        password: { algorithm: "scrypt", encoded: scryptPhc(PASSWORDS.alice), params: null },
        twoFactor: {
          enabled: true,
          secret: TOTP_TEXT,
          secretBase32: null,
          totp: { algorithm: "SHA1", digits: 6, periodSeconds: 30, keyEncoding: "utf8" },
          backupCodes: {
            algorithm: "sha256",
            encoding: "hex",
            hashes: [sha256(BACKUP_CODE), sha256("ZZ11-YY22")],
          },
        },
        avatar: "teal",
        createdAt: t(0),
        somethingNew: "ignored",
      }),
      person({
        ref: "per_bob",
        email: "bob@example.com",
        firstName: "Bob",
        password: { algorithm: "bcrypt", encoded: bcrypt, params: { variant: "2b", cost: 4 } },
        otherSignIns: ["GitHub"],
      }),
      person({
        ref: "per_carol",
        email: "carol@example.com",
        firstName: "Carol",
        password: scryptDeclared(PASSWORDS.carol),
        twoFactor: { enabled: true, unreadable: true },
      }),
      person({
        ref: "per_dave",
        email: "dave@example.com",
        emailVerified: false,
        firstName: "",
        password: {
          algorithm: "unknown",
          encoded: "5f4dcc3b5aa765d61d8327deb882cf99",
          params: null,
        },
      }),
      person({
        ref: "per_mallory",
        email: "mallory@example.com",
        firstName: "M",
        password: null,
        banned: true,
      }),
    ],
    "workspaces.jsonl": [
      {
        ref: "wsp_acme",
        name: "Acme",
        slug: "acme",
        oldSlugs: ["acme-old"],
        logo: null,
        ownerRef: "per_alice",
        personal: false,
        firstWorkspace: true,
        hostsAllowed: true,
        agentPolicies: { ...policiesOn, "Teleport servers": true },
        modelKey: "sk-or-v1-abcdefghijklmnop",
        researchKey: null,
        invitationEmail: { resendKey: "re_123456789abc", sender: "Acme <team@acme.test>" },
        createdAt: t(0),
      },
      {
        ref: "wsp_side",
        name: "Side Projects",
        slug: "side",
        oldSlugs: [],
        logo: null,
        ownerRef: "per_carol",
        personal: false,
        firstWorkspace: false,
        hostsAllowed: false,
        agentPolicies: policiesOn,
        modelKey: null,
        researchKey: null,
        invitationEmail: { resendKey: null, sender: null },
        createdAt: null,
      },
    ],
    "ssh-keys.jsonl": [
      {
        ref: "key_deploy",
        workspaceRef: "wsp_acme",
        name: "Deploy key",
        description: null,
        publicKey: key.publicKey,
        privateKey: key.privateKey,
        createdAt: null,
        lastUsedAt: null,
      },
    ],
    "servers.jsonl": [
      {
        ref: "srv_prod",
        workspaceRef: "wsp_acme",
        name: "prod-1",
        description: null,
        address: "198.51.100.20",
        port: 22,
        sshUser: "root",
        sshKeyRef: "key_deploy",
        hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
        hostnameLabel: "prod1",
        dailyCleanup: true,
        alertThresholds: { cpuPercent: 90, memoryPercent: 85 },
        createdAt: null,
        legacy: [{ kind: "swarm-service", name: "nearzero-router" }],
      },
      {
        ref: "srv_nokey",
        workspaceRef: "wsp_acme",
        name: "orphan",
        description: null,
        address: "198.51.100.21",
        port: 22,
        sshUser: "root",
        sshKeyRef: null,
        hostKeyFingerprint: null,
        hostnameLabel: null,
        dailyCleanup: false,
        alertThresholds: { cpuPercent: 0, memoryPercent: 0 },
        createdAt: null,
      },
    ],
    "git-providers.jsonl": [
      {
        ref: "git_github",
        workspaceRef: "wsp_acme",
        ownerRef: "per_alice",
        shared: true,
        kind: "GitHub",
        name: "Acme GitHub",
        connection: "Own app",
        urls: { web: "https://github.com/apps/nearzero-acme", internal: null, redirect: null },
        app: {
          appId: 123456,
          appName: "nearzero-acme",
          clientId: "Iv1.abc",
          clientSecret: "gh-client-secret",
          privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n",
          webhookSecret: "gh-webhook-secret",
        },
        oauth: null,
        installationIds: ["987654"],
        tokens: null,
        account: null,
        createdAt: null,
      },
    ],
    "zones.jsonl": [
      {
        ref: "zon_net",
        workspaceRef: "wsp_acme",
        domain: "example.net",
        adminEmail: "dns@example.net",
        nameservers: ["ns1.example.net", "ns2.example.net"],
        ttl: 600,
        records: [
          { name: "www", type: "CNAME", value: "example.net.", ttl: null, priority: null },
          { name: "example.net", type: "MX", value: "mail.example.net.", ttl: 3600, priority: 10 },
          {
            name: "old",
            type: "SRV",
            value: "0 5 5060 sip.example.net.",
            ttl: null,
            priority: null,
          },
        ],
        createdAt: null,
      },
    ],
    "projects.jsonl": [
      {
        ref: "prj_shop",
        workspaceRef: "wsp_acme",
        name: "Shop",
        description: "The store",
        createdAt: null,
      },
      {
        ref: "prj_internal",
        workspaceRef: "wsp_side",
        name: "Internal",
        description: null,
        createdAt: null,
      },
    ],
    "environments.jsonl": [
      {
        ref: "env_prod",
        projectRef: "prj_shop",
        name: "production",
        description: null,
        default: true,
        sharedVariables:
          "# shared\nLOG_LEVEL=warn\nREGION=eu\n# From the project\nSHARED_FROM_PROJECT=1\n",
        hostnameDefaults: { source: "Platform domain", zoneRef: null, prefix: null },
        createdAt: null,
      },
      {
        ref: "env_staging",
        projectRef: "prj_shop",
        name: "Staging Env",
        description: null,
        default: false,
        sharedVariables: "",
        hostnameDefaults: { source: "None", zoneRef: null, prefix: null },
        createdAt: null,
      },
      {
        ref: "env_internal",
        projectRef: "prj_internal",
        name: "production",
        description: null,
        default: true,
        sharedVariables: "",
        hostnameDefaults: { source: "Platform domain", zoneRef: null, prefix: null },
        createdAt: null,
      },
    ],
    "services.jsonl": [
      {
        ref: "svc_web",
        environmentRef: "env_prod",
        copyGroupRef: "grp_web",
        kind: "Application",
        name: "web",
        appName: "web-k3m9x2",
        description: null,
        place: { serverRef: "srv_prod" },
        variables: "# own\nDATABASE_URL=postgres://app:pw@pg-a1b2c3:5432/shop\n",
        settings: {
          source: {
            type: "GitHub",
            gitProviderRef: "git_github",
            owner: "acme",
            repository: "shop",
            branch: "main",
            path: "",
          },
          builder: {
            type: "Nixpacks",
            selection: "Chosen",
            runsOn: "Its server",
            publishDirectory: "",
            buildArgs: "",
            buildSecrets: "",
            cleanCache: false,
            submodules: false,
          },
          commands: { install: "", build: "npm run build", start: "", command: "", args: [] },
          ports: [{ published: 9000, target: 9000, protocol: "TCP" }],
          autodeploy: true,
          trigger: "Push",
          watchPaths: ["src/**"],
          webhookToken: WEBHOOK_TOKEN,
          // 29a.9: every mount names its path in the container; a file mount carries content.
          mounts: [
            { type: "Volume", containerPath: "/app/uploads", volume: "web-k3m9x2-uploads" },
            { type: "File", containerPath: "/app/config.json", content: '{"secret":true}' },
          ],
          replicas: 3,
          resources: null,
        },
        volumes: ["web-k3m9x2-uploads"],
        createdAt: t(1),
      },
      {
        ref: "svc_web_staging",
        environmentRef: "env_staging",
        copyGroupRef: "grp_web",
        kind: "Application",
        name: "web",
        appName: "web-p7q8r9",
        description: null,
        place: { serverRef: "srv_prod" },
        variables: "",
        settings: {
          source: {
            type: "GitHub",
            gitProviderRef: "git_github",
            owner: "acme",
            repository: "shop",
            branch: "staging",
          },
        },
        volumes: [],
        createdAt: t(2),
      },
      {
        ref: "svc_api",
        environmentRef: "env_prod",
        copyGroupRef: "grp_api",
        kind: "Application",
        name: "api",
        appName: "api-x1y2z3",
        description: null,
        place: { host: true },
        variables: "",
        settings: {
          source: {
            type: "Container image",
            image: "ghcr.io/acme/api:1.2.0",
            registryUrl: "ghcr.io",
            username: "acme",
            password: "ghcr-token",
          },
          builder: { type: "Buildpacks classic", selection: "Chosen" },
        },
        volumes: [],
        createdAt: t(3),
      },
      {
        ref: "svc_worker",
        environmentRef: "env_prod",
        copyGroupRef: "grp_worker",
        kind: "Application",
        name: "worker",
        appName: "worker-u1u2u3",
        description: null,
        place: { host: true },
        variables: "",
        settings: {
          source: {
            type: "Git URL",
            url: "git@github.com:acme/worker.git",
            branch: "main",
            path: "",
            sshKeyRef: "key_deploy",
          },
          builder: {
            type: "Dockerfile",
            selection: "Chosen",
            dockerfile: "Dockerfile.worker",
            contextPath: "",
            buildStage: "",
            buildArgs: "TOKEN=1",
            runsOn: "Nearzero host",
          },
          commands: { command: "node worker.js" },
        },
        volumes: [],
        createdAt: t(4),
      },
      {
        ref: "svc_stack",
        environmentRef: "env_prod",
        copyGroupRef: "grp_stack",
        kind: "Compose",
        name: "monitoring",
        appName: "monitoring-m1n2o3",
        description: null,
        place: { host: true },
        variables: "",
        settings: {
          source: { type: "Pasted Compose file" },
          format: "Compose",
          composeFile: "services:\n  grafana:\n    image: grafana/grafana\n",
          randomizeNames: true,
        },
        volumes: [],
        createdAt: t(5),
      },
      ...(
        [
          [
            "pg",
            "Postgres",
            "pg-a1b2c3",
            25432,
            { database: "shop", user: "app", password: "pg-pass-1" },
            {},
          ],
          [
            "mysql",
            "MySQL",
            "mysql-b1c2d3",
            23306,
            { database: "shop", user: "app", password: "my-pass", rootPassword: "my-root" },
            {},
          ],
          [
            "maria",
            "MariaDB",
            "maria-c1d2e3",
            null,
            { database: "legacy", user: "app", password: "ma-pass", rootPassword: "ma-root" },
            {},
          ],
          [
            "mongo",
            "MongoDB",
            "mongo-d1e2f3",
            31017,
            { user: "app", password: "mo-pass" },
            { replicaSet: true },
          ],
          ["cache", "Redis", "cache-e1f2g3", null, { password: "re-pass" }, {}],
          [
            "edge",
            "libSQL",
            "edge-f1g2h3",
            null,
            { user: "app", password: "li-pass" },
            {
              libsql: { node: "Primary", primaryUrl: null, namespaces: true },
              publicPorts: { http: 24080, grpc: 24081, admin: null },
            },
          ],
        ] as const
      ).map(([name, kind, appName, port, credentials, extra], index) => ({
        ref: `svc_${name}`,
        environmentRef: "env_prod",
        copyGroupRef: `grp_${name}`,
        kind,
        name,
        appName,
        description: null,
        place: kind === "Postgres" ? { serverRef: "srv_prod" } : { host: true },
        variables: "",
        settings: {
          image: kind === "Postgres" ? "postgres:16" : null,
          command: null,
          args: null,
          credentials,
          publicPort: port,
          ...extra,
        },
        volumes: [`${appName}-data`],
        createdAt: t(10 + index),
      })),
      {
        ref: "svc_tool",
        environmentRef: "env_internal",
        copyGroupRef: "grp_tool",
        kind: "Application",
        name: "tool",
        appName: "tool-h1h2h3",
        description: null,
        place: { host: true },
        variables: "",
        settings: { source: { type: "Container image", image: "nginx:alpine" } },
        volumes: [],
        createdAt: t(20),
      },
    ],
    "hostnames.jsonl": [
      hostname("hst_web_gen", "svc_web", "a1b2c3.prod1.apps.example.com", {
        port: 8080,
        certificate: "Let's Encrypt",
        source: "Server wildcard",
        serverRef: "srv_prod",
        generated: true,
      }),
      hostname("hst_web_own", "svc_web", "shop.example.org", {
        port: 8080,
        certificate: "Uploaded",
        source: "Own domain",
        serverRef: "srv_prod",
      }),
      hostname("hst_api", "svc_api", "api.apps.example.com", {
        port: 3000,
        path: "/v1",
        internalPath: "/",
        stripPath: true,
        source: "Platform domain",
        generated: true,
      }),
      hostname("hst_docs", "svc_stack", "docs.example.net", {
        innerService: "grafana",
        port: 3000,
        https: false,
        certificate: "None",
        source: "Managed DNS zone",
        zoneRef: "zon_net",
      }),
      hostname("hst_spare", null, "spare.example.net", {
        place: { host: true },
        source: "Managed DNS zone",
        zoneRef: "zon_net",
      }),
    ],
    "certificates.jsonl": [
      {
        ref: "crt_shop",
        workspaceRef: "wsp_acme",
        name: "Shop certificate",
        place: { serverRef: "srv_prod" },
        certificatePem: uploaded.certificate,
        privateKeyPem: uploaded.key,
        autoRenew: false,
      },
    ],
    "policies.jsonl": [
      {
        ref: "pol_deployers",
        workspaceRef: "wsp_acme",
        name: "Deployers",
        description: "Deploy the shop",
        capabilities: ["Create services", "Manage container registries"],
        scope: { ...NO_SCOPE, projectRefs: ["prj_shop"], serverRefs: ["srv_prod"] },
      },
    ],
    "memberships.jsonl": [
      membership("mem_alice_acme", "per_alice", "wsp_acme", "Owner"),
      membership("mem_bob_acme", "per_bob", "wsp_acme", "Member", {
        capabilities: ["Use the workspace's SSH keys"],
        scope: { ...NO_SCOPE, serviceRefs: ["svc_api"], gitProviderRefs: ["git_github"] },
        policyRefs: ["pol_deployers"],
      }),
      membership("mem_carol_side", "per_carol", "wsp_side", "Owner"),
      membership("mem_alice_side", "per_alice", "wsp_side", "Admin", { defaultWorkspace: false }),
      membership("mem_dave_acme", "per_dave", "wsp_acme", "Billing"),
    ],
    "invitations.jsonl": [
      {
        ref: "inv_erin",
        workspaceRef: "wsp_acme",
        email: "erin@example.com",
        role: "Member",
        policyRefs: ["pol_deployers"],
        invitedByRef: "per_alice",
        expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      },
      {
        ref: "inv_old",
        workspaceRef: "wsp_acme",
        email: "old@example.com",
        role: "Member",
        policyRefs: [],
        invitedByRef: null,
        expiresAt: t(-100),
      },
    ],
    "destinations.jsonl": [
      {
        ref: "dst_s3",
        workspaceRef: "wsp_acme",
        name: "S3 backups",
        provider: "AWS",
        endpoint: "https://s3.eu-west-1.amazonaws.com",
        bucket: "acme-backups",
        region: "eu-west-1",
        accessKey: "AKIAEXAMPLE",
        secretKey: "s3-secret-key",
        extraFlags: [],
        createdAt: null,
      },
    ],
    "backup-schedules.jsonl": [
      schedule("bkp_pg", "svc_pg", "Database", {
        database: "shop",
        folder: "pg",
        cron: "0 3 * * *",
        timeZone: "Europe/Berlin",
        keep: 14,
      }),
      schedule("bkp_uploads", "svc_web", "Volume", {
        name: "uploads",
        volume: "uploads",
        folder: "uploads",
        // The last day of the month, as 0.1.x ran it (G3-14).
        cron: "30 4 L * *",
        stopWhileCopying: true,
      }),
      schedule("bkp_compose_db", "svc_stack", "Database", {
        database: "grafana",
        composeDatabase: {
          innerService: "db",
          type: "Postgres",
          credentials: { user: "g", password: "x" },
        },
        innerService: "db",
        folder: "grafana",
        cron: "0 5 * * *",
      }),
    ],
    "tasks.jsonl": [
      task("tsk_host", { host: true }, "Prune logs", {
        cron: "0 * * * *",
        shell: "bash",
        script: "find /var/log -name '*.gz' -mtime +7 -delete\r\n",
        // Its 0.1.x owner, who is moved too (R3-29).
        ownerRef: "per_bob",
      }),
      task("tsk_server", { serverRef: "srv_prod" }, "Disk report", {
        // The first Monday of the month, as 0.1.x ran it (G3-14).
        cron: "0 9 * * 1#1",
        timeZone: "Europe/Paris",
        shell: "sh",
        script: "df -h",
      }),
      task("tsk_container", { serviceRef: "svc_stack", innerService: "grafana" }, "Reload", {
        cron: "0 4 * * 1",
        shell: "sh",
        script: "kill -HUP 1",
        enabled: false,
      }),
    ],
    "channels.jsonl": [
      {
        ref: "chn_slack",
        workspaceRef: "wsp_acme",
        kind: "Slack",
        name: "Deploys",
        fields: { Channel: "#deploys" },
        secrets: { "Webhook URL": "https://hooks.slack.com/services/T000/B000/XXXX" },
        events: ["Deployment failed", "Deployment succeeded", "Nearzero backup"],
        createdAt: null,
      },
      {
        ref: "chn_hook",
        workspaceRef: "wsp_acme",
        kind: "Webhook",
        name: "Hook",
        // A trailing "/" that the receiver needs is kept (G3-17).
        fields: { URL: "https://hooks.example.com/nearzero/" },
        secrets: { Headers: { Authorization: "Bearer hook-token" } },
        events: ["Server over its alert threshold"],
        createdAt: null,
      },
      {
        ref: "chn_fax",
        workspaceRef: "wsp_acme",
        kind: "Fax",
        name: "Fax",
        fields: {},
        secrets: {},
        events: [],
        createdAt: null,
      },
    ],
    "agent-sessions.jsonl": [
      {
        ref: "ses_1",
        workspaceRef: "wsp_acme",
        authorRef: "per_alice",
        shared: false,
        parentRef: null,
        title: "Deploy the shop",
        position: 2,
        messages: [
          {
            role: "Person",
            text: "Deploy web please",
            steps: [],
            attachments: 1,
            createdAt: t(29),
          },
          {
            role: "Agent",
            text: "Deployed web.",
            steps: [
              { action: "Started a deploy of web", outcome: "Done" },
              { action: "Checked web", outcome: "Failed" },
            ],
            attachments: 0,
            createdAt: t(29),
          },
          { role: "Person", text: "Thanks", steps: [], attachments: 0, createdAt: t(29) },
          { role: "Agent", text: "You're welcome.", steps: [], attachments: 0, createdAt: t(29) },
        ],
        createdAt: t(29),
        updatedAt: t(29),
      },
      {
        ref: "ses_2",
        workspaceRef: "wsp_acme",
        authorRef: null,
        shared: true,
        parentRef: null,
        title: "Old chat",
        position: 1,
        messages: [{ role: "Agent", text: "Hello", steps: [], attachments: 0, createdAt: null }],
        createdAt: null,
        updatedAt: null,
      },
    ],
    "deployments.jsonl": [
      {
        ref: "dep_1",
        serviceRef: "svc_web",
        status: "Failed",
        title: "Fix the cart",
        commit: "a1b2c3d",
        trigger: "Push",
        error: "Build failed",
        createdAt: t(28),
        startedAt: null,
        finishedAt: null,
        log: "Cloning\nBuilding\nerror: oops\n",
        logTruncated: false,
        logMissing: false,
      },
      {
        ref: "dep_2",
        serviceRef: "svc_web",
        status: "Running",
        title: "Fix the cart again",
        commit: "d4e5f6a",
        trigger: "Rollback",
        error: null,
        createdAt: t(30),
        startedAt: t(30),
        finishedAt: t(30),
        log: "Cloning\nBuilding\nDone\n",
        logTruncated: true,
        logMissing: false,
      },
      ...(
        [
          ["svc_api", 20],
          ["svc_worker", 25],
          ["svc_stack", 10],
          ["svc_pg", 1],
          ["svc_mysql", 2],
          ["svc_maria", 3],
          ["svc_mongo", 4],
          ["svc_cache", 5],
          ["svc_edge", 6],
          ["svc_tool", 40],
        ] as const
      ).map(([serviceRef, day]) => ({
        ref: `dep_${serviceRef}`,
        serviceRef,
        status: "Succeeded",
        title: "Deploy",
        commit: null,
        trigger: "Manual",
        error: null,
        createdAt: t(day),
        startedAt: t(day),
        finishedAt: t(day),
        log: "",
        logTruncated: false,
        logMissing: true,
      })),
    ],
  };

  return {
    serverRef: "srv_prod",
    content: {
      sourceVersion: "0.1.80",
      records,
      notes: [
        {
          kind: "service",
          ref: "svc_web",
          name: "web",
          reason: "Its health check isn't carried (29a.7).",
        },
      ],
      extra: {
        "install.json": {
          sourceVersion: "0.1.80",
          platformDomain: "apps.example.com",
          platformDomainSharedEdge: false,
          consoleHostname: "nearzero.example.com",
          consoleHttps: true,
          letsEncryptEmail: "certs@example.com",
          managedZone: null,
          managedDnsEnabled: false,
          publicIp: "203.0.113.10",
          dataMode: "Bundled database",
          registrationMode: "Invitations only",
          adminEmail: "alice@example.com",
          ownerClaimedAt: null,
          monitoring: {
            refreshSeconds: null,
            retentionDays: null,
            cron: null,
            thresholds: { cpuPercent: 95, memoryPercent: 90 },
          },
          analytics: { requestLogging: false },
          hostDailyCleanup: true,
          logCleanupCron: null,
          controlPlane: [
            { kind: "swarm-service", name: "nearzero_app" },
            { kind: "swarm-service", name: "nearzero_postgres" },
            { kind: "container", name: "nearzero-traefik" },
          ],
        },
        "acme/host/acme.json": {
          letsencrypt: {
            Account: {
              Email: "certs@example.com",
              Registration: { uri: "https://acme.test/acct/1", body: { status: "valid" } },
              PrivateKey: "MIIEowIBAAKCAQEA",
              KeyType: "4096",
            },
            Certificates: [
              {
                domain: { main: "api.apps.example.com" },
                certificate: b64(issuedHost.certificate),
                key: b64(issuedHost.key),
                Store: "default",
              },
            ],
          },
        },
        "acme/srv_prod/acme.json": {
          myresolver: {
            Account: {
              Email: "certs@example.com",
              Registration: { uri: "https://acme.test/acct/2", body: {} },
              PrivateKey: "MIIEpAIBAAKCAQEA",
              KeyType: "4096",
            },
            Certificates: [
              {
                domain: { main: "a1b2c3.prod1.apps.example.com" },
                certificate: b64(issuedServer.certificate),
                key: b64(issuedServer.key),
                Store: "default",
              },
              {
                domain: { main: "broken.example.com" },
                certificate: "bm90IGEgY2VydA==",
                key: "eA==",
              },
            ],
          },
        },
      },
    },
  };
}

function hostname(
  ref: string,
  serviceRef: string | null,
  host: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ref,
    serviceRef,
    innerService: null,
    place: null,
    host,
    port: null,
    path: "/",
    internalPath: "/",
    stripPath: false,
    https: true,
    certificate: "Let's Encrypt",
    source: "Own domain",
    zoneRef: null,
    serverRef: null,
    generated: false,
    createdAt: null,
    ...fields,
  };
}

function membership(
  ref: string,
  personRef: string,
  workspaceRef: string,
  role: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ref,
    personRef,
    workspaceRef,
    role,
    capabilities: [],
    scope: NO_SCOPE,
    policyRefs: [],
    defaultWorkspace: true,
    createdAt: null,
    ...fields,
  };
}

function schedule(
  ref: string,
  serviceRef: string,
  kind: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ref,
    serviceRef,
    destinationRef: "dst_s3",
    kind,
    name: null,
    database: null,
    composeDatabase: null,
    volume: null,
    innerService: null,
    timeZone: null,
    keep: null,
    enabled: true,
    stopWhileCopying: false,
    createdAt: null,
    ...fields,
  };
}

function task(
  ref: string,
  place: Record<string, unknown>,
  name: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ref,
    workspaceRef: "wsp_acme",
    place,
    name,
    description: null,
    timeZone: null,
    enabled: true,
    createdAt: null,
    ...fields,
  };
}
