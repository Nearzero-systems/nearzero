import type { AgentFormAnswer, FormRequest, GitProviderKind } from "@nearzero/shared";
import { getRepository, listBranches, usableProviders } from "../../git-providers/area.ts";
import { managedProvider } from "../../git-providers/records.ts";
import type { AgentContext } from "../context.ts";
import { agentSettings } from "../settings.ts";
import { advance, type ImportState, newImportState, resumeImport } from "./git-import.ts";
import {
  bold,
  expected,
  type FlowModule,
  type FlowResult,
  type FlowRun,
  type FlowState,
  picker,
  refuse,
  row,
} from "./kit.ts";
import type { ImportDetails, RepositoryLink } from "./parse.ts";
import { HOST_LABELS, type PublicGitHost, publicCloneUrl } from "./public-repo.ts";

/**
 * A pasted repository link (30d R4-01, spec 19.7 as 0.1.79 does it): nothing is promised before
 * the repository is known to be readable.
 * 1. A connected account that can see it is used, so pushes redeploy it; the public URL isn't
 *    asked then.
 * 2. Otherwise the host is asked over Git, with no login, whether anyone may read it. A public
 *    repository is deployed from its URL, on the /tree/ branch when it has it, else its default
 *    branch, else main or master, else its only branch, else a branch picker.
 * 3. Private or missing: a card to give Nearzero access (Give access on GitHub, Connect <Host>,
 *    Check again), and nothing is created until it can be read.
 * After that it is the usual import: project, server, how it runs, variables, deploy and wait.
 */

export interface LinkIntent extends Partial<ImportDetails> {
  link: RepositoryLink;
  project: string | null;
  server: string | null;
  deploy: boolean;
}

interface LinkState extends FlowState {
  stage: "link";
  want: LinkIntent;
  asking: "access" | "branch";
  offered: string[];
  /** The public repository's branches, while the person picks one. */
  publicBranches: string[];
}

/** The provider kind that can hold a repository of this host, and how to tell it's that host. */
export const KIND_OF: Record<PublicGitHost, GitProviderKind> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
  "codeberg.org": "gitea",
};

function importIntent(want: LinkIntent) {
  return {
    repository: want.link.fullName,
    provider: KIND_OF[want.link.host],
    project: want.project,
    server: want.server,
    branch: want.link.branch,
    deploy: want.deploy,
    name: want.name ?? null,
    builder: want.builder ?? null,
    folder: want.folder ?? null,
  };
}

/** Connected accounts that may hold the repository: its kind, on its host for GitLab and Gitea. */
export async function candidateAccounts(ctx: AgentContext, host: PublicGitHost) {
  const kind = KIND_OF[host];
  const ready = (await usableProviders(ctx.services, ctx.actor, kind)).filter((item) => item.ready);
  if (kind !== "gitlab" && kind !== "gitea") return ready;
  const rows = await ctx.services.db
    .selectFrom("git_provider")
    .select(["id", "settings"])
    .where("workspace_id", "=", ctx.actor.workspace.id)
    .where("kind", "=", kind)
    .execute();
  const onHost = new Set(
    rows
      .filter((item) => {
        const url = (item.settings as { url?: unknown } | null)?.url;
        try {
          return typeof url === "string" && new URL(url).hostname === host;
        } catch {
          return false;
        }
      })
      .map((item) => item.id),
  );
  return ready.filter((item) => onHost.has(item.id));
}

/** The branch to deploy: the /tree/ branch when the repository has it, else its default. */
export function chosenBranch(
  wanted: string | null,
  defaultBranch: string | null,
  branches: string[],
): string | null {
  if (wanted && branches.includes(wanted)) return wanted;
  if (defaultBranch && branches.includes(defaultBranch)) return defaultBranch;
  return (
    branches.find((name) => name === "main") ??
    branches.find((name) => name === "master") ??
    (branches.length === 1 ? (branches[0] as string) : null)
  );
}

async function check(run: FlowRun, want: LinkIntent): Promise<FlowResult> {
  const { ctx } = run;
  const { link } = want;
  const hostLabel = HOST_LABELS[link.host];

  // 1. A connected account that can see it.
  const accounts = await candidateAccounts(ctx, link.host);
  for (const account of accounts) {
    try {
      const repo = await getRepository(ctx.services, ctx.actor, account.id, link.fullName);
      const state = newImportState(importIntent(want));
      state.provider = { id: account.id, name: account.name, kind: account.kind };
      state.repository = { fullName: repo.fullName, defaultBranch: repo.defaultBranch };
      if (link.branch) {
        const listed = await listBranches(ctx.services, ctx.actor, account.id, repo.fullName);
        const names = listed.branches.map((branch) => branch.name);
        // The /tree/ branch only when the repository has it; otherwise its default branch.
        state.want.branch = names.includes(link.branch) ? link.branch : null;
      }
      return advance(run, state);
    } catch (error) {
      if (!expected(error)) throw error;
    }
  }

  // 2. Anyone may read it?
  const url = publicCloneUrl(link.host, link.fullName);
  const refs = await row(
    run,
    { running: "Checking repository", done: "Checked repository" },
    `${link.fullName} on ${hostLabel}`,
    async () => {
      const found = await agentSettings(ctx.services).publicRepositories.refs(url);
      return {
        value: found,
        target: `${link.fullName} on ${hostLabel}`,
        result:
          found.kind === "public"
            ? "Public"
            : found.kind === "private"
              ? "Private or missing"
              : "Couldn't reach it",
      };
    },
  );
  if (refs.kind === "unreachable") {
    run.say(
      `I couldn't reach ${link.host} to check ${bold(link.fullName)}: ${refs.reason} Nothing was created. Try again in a moment.`,
    );
    return { kind: "done", summary: `${link.host} couldn't be reached; nothing was created.` };
  }
  if (refs.kind === "public") {
    if (refs.branches.length === 0) {
      run.say(
        `${bold(link.fullName)} on ${hostLabel} is public, but it has no branches yet. Push some code to it, then ask again.`,
      );
      return { kind: "done", summary: `${link.fullName} has no branches; nothing was created.` };
    }
    const branch = chosenBranch(link.branch, refs.defaultBranch, refs.branches);
    if (!branch) {
      const state: LinkState = {
        stage: "link",
        want,
        asking: "branch",
        offered: refs.branches,
        publicBranches: refs.branches,
      };
      return {
        kind: "ask",
        form: picker(
          "branch",
          `Choose the branch of ${link.fullName} to deploy`,
          refs.branches.map((name) => ({ value: name, label: name })),
        ),
        waitLabel: "Waiting for a branch",
        state,
      };
    }
    return advance(run, publicState(want, branch));
  }

  // 3. Private or missing: nothing is created; the person can give access and check again.
  const card = await accessCard(ctx, link, accounts);
  run.say(card.text);
  if (!card.form) {
    return { kind: "done", summary: `${link.fullName} can't be read; nothing was created.` };
  }
  const state: LinkState = {
    stage: "link",
    want,
    asking: "access",
    offered: card.form.options.map((option) => option.value),
    publicBranches: [],
  };
  return {
    kind: "ask",
    form: card.form,
    waitLabel: ACCESS_WAIT_LABEL,
    state,
    connectReturn: true,
  };
}

export const ACCESS_WAIT_LABEL = "Waiting for access to the repository";

/**
 * What a private or missing repository gets (30d R4-01): the words, and the card that gives
 * Nearzero access (Give access on GitHub, Connect <Host>, Check again), or no card for someone
 * who may not connect accounts. The guided flow and the model's Git action both use it.
 */
export async function accessCard(
  ctx: AgentContext,
  link: RepositoryLink,
  accounts: { id: string; name: string; account: string | null }[],
): Promise<{ text: string; form: Extract<FormRequest, { kind: "picker" }> | null }> {
  const hostLabel = HOST_LABELS[link.host];
  const none = accounts.length === 0;
  const first = `I can't open ${link.fullName}. It's private or doesn't exist, and ${
    none
      ? `no ${hostLabel} account is connected to Nearzero.`
      : `none of your connected ${hostLabel} accounts can see it.`
  }`;
  if (!ctx.actor.access.can("git-accounts.connect-own")) {
    return {
      text: `${first} Check the link, or ask an owner or admin to connect the ${hostLabel} account that owns it (Settings → Git providers). Nothing was created.`,
      form: null,
    };
  }
  const slug = ctx.actor.workspace.slug;
  const back = `/${slug}/dashboard/agent?session=${ctx.session.id}`;
  const settings = `/${slug}/dashboard/settings/git-providers`;
  const connect = (kind: GitProviderKind) =>
    `${settings}?connect=${kind}&return=${encodeURIComponent(back)}`;
  // The Nearzero GitHub App's install page for each GitHub account the person may manage. The
  // button is a console address that starts the install when it's opened (C3-01), so the link
  // never goes stale and the person comes back to this chat afterwards.
  const installs: { id: string; label: string; href: string }[] = [];
  if (link.host === "github.com") {
    for (const account of accounts) {
      try {
        await managedProvider(ctx.services, ctx.actor, account.id);
        installs.push({
          id: account.id,
          label: account.account ?? account.name,
          href: `${settings}?install=${encodeURIComponent(account.id)}&return=${encodeURIComponent(back)}`,
        });
      } catch (error) {
        if (!expected(error)) throw error;
      }
    }
  }
  const options = [
    ...installs.map((install) => ({
      value: `install:${install.id}`,
      label: installs.length > 1 ? `Give ${install.label} access` : "Give access on GitHub",
      icon: "github",
      href: install.href,
    })),
    {
      value: `connect:${KIND_OF[link.host]}`,
      label: `Connect ${hostLabel}`,
      icon: KIND_OF[link.host],
      href: connect(KIND_OF[link.host]),
    },
    { value: "check", label: "Check again" },
  ];
  return {
    text: `${first}\n\nGive Nearzero access to it, then check again. If it's meant to be public, check the link.`,
    // Actions, not a list of repositories: always buttons (C3-02).
    form: picker("access", `Give Nearzero access to ${link.fullName}`, options),
  };
}

function publicState(want: LinkIntent, branch: string): ImportState {
  const state = newImportState(importIntent(want));
  state.public = { url: publicCloneUrl(want.link.host, want.link.fullName), host: want.link.host };
  state.repository = { fullName: want.link.fullName, defaultBranch: branch };
  state.branch = branch;
  return state;
}

async function start(run: FlowRun, want: LinkIntent): Promise<FlowResult> {
  const refused = await refuse(
    run,
    ["services.configure", "services.import-git"],
    "create_app_from_git_url",
    want.link.fullName,
  );
  if (refused) return refused;
  return check(run, want);
}

export const gitLinkFlow: FlowModule<LinkIntent> = {
  start,
  async resume(run: FlowRun, raw: FlowState, answer: AgentFormAnswer) {
    if (raw.stage !== "link") return resumeImport(run, raw, answer);
    const state = raw as LinkState;
    if (state.asking === "branch") {
      const chosen =
        answer.outcome === "chosen" && typeof answer.option === "string" ? answer.option : null;
      if (!chosen || !state.publicBranches.includes(chosen)) {
        run.say("That wasn't one of the branches, so nothing was created. Pick one of them.");
        return check(run, state.want);
      }
      return advance(run, publicState(state.want, chosen));
    }
    // Back from giving access (or "Check again"): look again from the start.
    return check(run, state.want);
  },
};
