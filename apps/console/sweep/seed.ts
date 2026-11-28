import { ApiSession, type Stack } from "../test-support/stack.ts";

/**
 * The people the sweep signs in as, made through the API on a fresh stack (spec 04):
 * - Maya, the owner from `create-owner`, of "Acme" (slug acme) and of "Side projects";
 * - in Acme, the project "storefront" (development and production) with an application, a
 *   Compose service, PostgreSQL and Redis (each copied into production) and variables with
 *   comments, and an empty project "marketing-site";
 * - Sam, a member of Acme with the "Developers" policy and the one-project "Storefront team"
 *   policy;
 * - Lee, a member of Acme with a pending invitation to Side projects (the bell, the invitation
 *   page by id, and sign-in from a link for an existing account);
 * - invitations for kim@ (no account: sign-up) and a cancelled one.
 * Seeding runs in steps so the onboarding pages can be swept while someone is on them.
 */

export const PASSWORD = "sweep-password-1";
export const OWNER_EMAIL = "owner@example.com";

interface Invitation {
  id: string;
  email: string;
}

export interface Seeded {
  project: string;
  development: string;
  production: string;
  app: string;
  compose: string;
  database: string;
  redis: string;
  emptyProject: string;
  emptyEnvironment: string;
}

export interface People {
  projects: Seeded;
  owner: string;
  ownerSide: string;
  member: string;
  lee: string;
  leeInvitationId: string;
  tokens: { lee: string; kim: string; cancelled: string };
}

function tokenOf(link: string): string {
  return new URL(link).searchParams.get("token") ?? "";
}

export class Seeder {
  private owner!: ApiSession;
  private sam!: ApiSession;

  constructor(private readonly stack: Stack) {}

  private get base(): string {
    return this.stack.consoleUrl;
  }

  /** The owner exists and is on onboarding step 1. */
  async ownerOnWorkspaceStep(): Promise<string> {
    await this.stack.createOwner(OWNER_EMAIL, PASSWORD);
    this.owner = await ApiSession.signIn(this.base, OWNER_EMAIL, PASSWORD);
    return this.owner.sessionToken();
  }

  /** The owner is on step 2 and Sam, just added with a password, on the member name step. */
  async ownerOnInviteStepAndMemberOnName(): Promise<{ owner: string; member: string }> {
    await this.owner.call("POST", "/onboarding/workspace", {
      name: "Maya Lopez",
      workspaceName: "Acme",
    });
    await this.owner.call("POST", "/workspace/members", {
      email: "sam@example.com",
      role: "member",
      password: PASSWORD,
    });
    this.sam = await ApiSession.signIn(this.base, "sam@example.com", PASSWORD);
    return { owner: this.owner.sessionToken(), member: this.sam.sessionToken() };
  }

  /** Everyone finished onboarding, with policies, invitations and a second workspace. */
  async everyone(): Promise<People> {
    const owner = this.owner;
    await owner.call("POST", "/onboarding/skip-invitations");
    await this.sam.call("POST", "/onboarding/name", { name: "Sam Rivera" });

    // Real projects, environments, services and variables (spec 05).
    const shop = await owner.call<{ project: { id: string }; environmentId: string }>(
      "POST",
      "/projects",
      { name: "storefront", description: "The shop and its database." },
    );
    const production = await owner.call<{ environment: { id: string } }>(
      "POST",
      `/projects/${shop.project.id}/environments`,
      { name: "production" },
    );
    const service = async (body: Record<string, unknown>) =>
      (
        await owner.call<{ service: { id: string } }>(
          "POST",
          `/environments/${shop.environmentId}/services`,
          { serverId: "host", ...body },
        )
      ).service.id;
    const app = await service({
      kind: "application",
      name: "web",
      settings: { image: "nginx:alpine", servicePort: 8080 },
    });
    const compose = await service({
      kind: "compose",
      name: "reports",
      settings: { composeFile: "services:\n  web:\n    image: nginx:alpine\n" },
    });
    const database = await service({ kind: "postgres", name: "db" });
    const redis = await service({ kind: "redis", name: "cache" });
    // Backups (spec 17): a destination, a nightly dump of the database, and the app's volume.
    await owner.call("PUT", `/services/${app}/mounts`, {
      mounts: [{ type: "volume", name: "uploads", containerPath: "/srv/uploads" }],
    });
    const appName = (await owner.call<{ service: { appName: string } }>("GET", `/services/${app}`))
      .service.appName;
    const destination = await owner.call<{ destination: { id: string } }>(
      "POST",
      "/backup-destinations",
      {
        name: "Offsite",
        provider: "cloudflare-r2",
        endpoint: "https://0a1b2c3d4e5f.r2.cloudflarestorage.com",
        bucket: "acme-backups",
        region: "auto",
        accessKeyId: "sweep-access-key",
        secretAccessKey: "sweep-secret-access-key",
      },
    );
    await owner.call("POST", `/services/${database}/backup-schedules`, {
      destinationId: destination.destination.id,
      folder: "nightly",
      cron: "0 3 * * *",
      keep: 7,
    });
    await owner.call("POST", `/services/${app}/backup-schedules`, {
      destinationId: destination.destination.id,
      volume: `${appName}-uploads`,
      folder: "uploads",
      cron: "0 * * * *",
      keep: null,
      stopService: false,
    });
    await owner.call("PUT", `/environments/${shop.environmentId}/variables`, {
      text: "# Shared by every service\nAPI_URL=https://api.example.com\nLOG_LEVEL=info\n",
    });
    await owner.call("PUT", `/services/${app}/variables`, {
      text: "# The API this app calls\nAPI_URL=https://own.example.com\nEMPTY=\n",
    });
    const marketing = await owner.call<{ project: { id: string }; environmentId: string }>(
      "POST",
      "/projects",
      { name: "marketing-site" },
    );

    const developers = await owner.call<{ policy: { id: string } }>("POST", "/workspace/policies", {
      name: "Developers",
      description: "Builds and deploys the team's apps.",
      capabilities: [
        "projects.create",
        "environments.create",
        "services.create",
        "git.connect-own",
      ],
      scope: { allServers: true },
    });
    await owner.call("POST", "/workspace/policies", {
      name: "Support",
      description: "Reads logs and redeploys when something is stuck.",
      capabilities: [],
      scope: { allProjects: true },
    });
    const members = await owner.call<{ members: { person: { id: string; email: string } }[] }>(
      "GET",
      "/workspace/members",
    );
    const samId = members.members.find((item) => item.person.email === "sam@example.com")?.person
      .id;
    // A one-project policy: Sam reaches storefront and nothing else.
    const team = await owner.call<{ policy: { id: string } }>("POST", "/workspace/policies", {
      name: "Storefront team",
      description: "Works on the shop.",
      capabilities: ["services.create", "environments.create"],
      scope: { projectIds: [shop.project.id] },
    });
    await owner.call("PUT", `/workspace/members/${samId}/access`, {
      policyIds: [developers.policy.id, team.policy.id],
      capabilities: ["dns.manage"],
      scope: {},
    });

    const kim = await owner.call<{ invitation: Invitation; delivery: { link: string } }>(
      "POST",
      "/workspace/invitations",
      { email: "kim@example.com", role: "member", policyIds: [developers.policy.id] },
    );
    await owner.call("POST", "/workspace/invitations", { email: "ari@example.com", role: "admin" });
    const gone = await owner.call<{ invitation: Invitation; delivery: { link: string } }>(
      "POST",
      "/workspace/invitations",
      { email: "gone@example.com", role: "member" },
    );
    await owner.call("DELETE", `/workspace/invitations/${gone.invitation.id}`);

    await owner.call("POST", "/workspace/members", {
      email: "lee@example.com",
      role: "member",
      password: PASSWORD,
    });
    const lee = await ApiSession.signIn(this.base, "lee@example.com", PASSWORD);
    await lee.call("POST", "/onboarding/name", { name: "Lee Chen" });

    // A second workspace, in its own owner session so the first stays on Acme.
    const side = await ApiSession.signIn(this.base, OWNER_EMAIL, PASSWORD);
    const created = await side.call<{ workspace: { id: string } }>("POST", "/workspaces", {
      name: "Side projects",
    });
    await side.call("POST", `/workspaces/${created.workspace.id}/switch`);
    const leeInvite = await side.call<{ invitation: Invitation; delivery: { link: string } }>(
      "POST",
      "/workspace/invitations",
      { email: "lee@example.com", role: "member" },
    );

    return {
      projects: {
        project: shop.project.id,
        development: shop.environmentId,
        production: production.environment.id,
        app,
        compose,
        database,
        redis,
        emptyProject: marketing.project.id,
        emptyEnvironment: marketing.environmentId,
      },
      owner: owner.sessionToken(),
      ownerSide: side.sessionToken(),
      member: this.sam.sessionToken(),
      lee: lee.sessionToken(),
      leeInvitationId: leeInvite.invitation.id,
      tokens: {
        lee: tokenOf(leeInvite.delivery.link),
        kim: tokenOf(kim.delivery.link),
        cancelled: tokenOf(gone.delivery.link),
      },
    };
  }
}
