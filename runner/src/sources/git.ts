import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  looksTransient,
  MAX_ATTEMPTS,
  pause,
  retryDelaySeconds,
  retryWords,
} from "../builds/transient.ts";
import { type CommandResult, runCommand } from "../exec/command.ts";
import { dropOutsideLinks } from "./links.ts";

/**
 * Fetching a repository into a service's source folder (spec 6.1, 6.3): a shallow fetch of the
 * branch's newest commit, a given commit, or a tag, then a checkout of exactly that. Over SSH a
 * saved deploy key is written to a 0600 file for the fetch only, with this service's own known
 * hosts file (new hosts are remembered on first use, a changed host key is refused).
 *
 * Every git call goes through the one command runner: no shell, standard input closed, a
 * timeout, and the key's text cut out of anything printed.
 *
 * Links in the repository that lead outside it are removed after the checkout (and named in
 * the log): the runner and the builders run as root, so nothing may be read or written through
 * such a link (spec 22.2, 24 G3).
 */

export interface GitFetch {
  url: string;
  branch: string;
  commit?: string;
  tag?: string;
  sshPrivateKey?: string;
  /** A connected provider's short-lived credentials for an HTTPS URL (never in the URL). */
  httpAuth?: { username: string; password: string };
  submodules: boolean;
}

/**
 * Git configuration, passed through the environment, that sends the credentials only to the
 * repository's own host (scheme, host and port), as an Authorization header. Nothing is written
 * to disk and the URL stays clean, so logs and `git remote -v` never show a token.
 */
export function httpAuthConfig(
  url: string,
  auth: { username: string; password: string },
): { env: Record<string, string>; secrets: string[] } {
  const origin = new URL(url).origin;
  const encoded = Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64");
  return {
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${encoded}`,
    },
    secrets: [auth.password, encoded],
  };
}

export interface GitFetched {
  commit: string;
  subject: string;
  branch: string;
}

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

const FETCH_TIMEOUT_MS = 15 * 60_000;

export interface GitContext {
  /** The service's folder: source/ and known_hosts live in it. */
  folder: string;
  home: string;
  signal: AbortSignal;
  onOutput: (text: string) => void;
}

function explain(result: CommandResult, what: string): string {
  const output = result.output.trim();
  if (/could not read Username|Authentication failed|terminal prompts disabled/i.test(output)) {
    return `${what} failed: the repository is private or doesn't exist. Use an SSH URL with a deploy key, or connect a Git provider.`;
  }
  if (/Permission denied \(publickey\)/i.test(output)) {
    return `${what} failed: the server refused the SSH key. Add the key's public half as a deploy key on the repository.`;
  }
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(output)) {
    return `${what} failed: the Git host's key changed since the last deploy. If that's expected, remove the service's saved host key by changing its source, then deploy again.`;
  }
  if (/couldn't find remote ref|Remote branch .* not found|not our ref/i.test(output)) {
    return `${what} failed: the branch, tag or commit doesn't exist in the repository.`;
  }
  if (/Could not resolve host|Connection timed out|Connection refused/i.test(output)) {
    return `${what} failed: the Git host can't be reached from this server.`;
  }
  if (result.timedOut) return `${what} took more than 15 minutes and was stopped.`;
  return `${what} failed (exit code ${result.exitCode ?? "none"}).`;
}

export async function fetchRepository(spec: GitFetch, context: GitContext): Promise<GitFetched> {
  const source = join(context.folder, "source");
  await rm(source, { recursive: true, force: true });
  await mkdir(source, { recursive: true, mode: 0o755 });
  await mkdir(context.home, { recursive: true, mode: 0o700 });
  const secrets = spec.sshPrivateKey ? [spec.sshPrivateKey] : [];
  const env: Record<string, string> = {
    HOME: context.home,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  if (spec.httpAuth && /^https?:\/\//.test(spec.url)) {
    const auth = httpAuthConfig(spec.url, spec.httpAuth);
    Object.assign(env, auth.env);
    secrets.push(...auth.secrets);
  }
  let keyFile: string | null = null;
  if (spec.sshPrivateKey) {
    keyFile = join(context.folder, `.deploy-key-${crypto.randomUUID()}`);
    const key = spec.sshPrivateKey.endsWith("\n") ? spec.sshPrivateKey : `${spec.sshPrivateKey}\n`;
    await writeFile(keyFile, key, { mode: 0o600 });
    env.GIT_SSH_COMMAND = [
      "ssh",
      "-i",
      keyFile,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${join(context.folder, "known_hosts")}`,
      "-o",
      "ConnectTimeout=20",
    ].join(" ");
  } else {
    env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20";
  }
  const git = async (args: string[], what: string, quiet = false, retry = false) => {
    for (let next = 2; ; next++) {
      const result = await runCommand({
        argv: ["git", ...args],
        cwd: source,
        env,
        timeoutMs: FETCH_TIMEOUT_MS,
        secrets,
        signal: context.signal,
        ...(quiet ? {} : { onOutput: (text: string) => context.onOutput(text) }),
      });
      if (result.cancelled) throw new GitError("Cancelled.");
      if (result.exitCode === 0) return result.output.trim();
      // A dropped connection or a busy host is tried again (R2-08); a real refusal isn't.
      if (retry && next <= MAX_ATTEMPTS && !result.timedOut && looksTransient(result.output)) {
        context.onOutput(
          `${what} failed with what looks like a passing network problem; ${retryWords(next)}.\n`,
        );
        await pause(retryDelaySeconds(next), context.signal);
        if (context.signal.aborted) throw new GitError("Cancelled.");
        continue;
      }
      throw new GitError(explain(result, what));
    }
  };
  try {
    const ref = spec.commit ?? (spec.tag ? `refs/tags/${spec.tag}` : `refs/heads/${spec.branch}`);
    const shown = spec.commit
      ? spec.commit.slice(0, 7)
      : spec.tag
        ? `tag ${spec.tag}`
        : spec.branch;
    context.onOutput(`Fetching ${shown} from ${spec.url}\n`);
    await git(["init", "--quiet"], "Preparing the source folder", true);
    await git(["remote", "add", "origin", "--", spec.url], "Preparing the source folder", true);
    try {
      await git(
        ["fetch", "--depth", "1", "--no-tags", "origin", ref],
        "Fetching the repository",
        false,
        true,
      );
    } catch (error) {
      // Some hosts don't serve single commits; fall back to the branch and look for it there.
      if (!spec.commit) throw error;
      context.onOutput(
        `The host didn't serve commit ${shown} directly; fetching ${spec.branch}.\n`,
      );
      await git(
        ["fetch", "--depth", "50", "--no-tags", "origin", `refs/heads/${spec.branch}`],
        "Fetching the repository",
        false,
        true,
      );
      await git(["cat-file", "-e", `${spec.commit}^{commit}`], `Finding commit ${shown}`, true);
    }
    await git(
      ["-c", "advice.detachedHead=false", "checkout", "--quiet", spec.commit ?? "FETCH_HEAD"],
      "Checking out the source",
    );
    if (spec.submodules) {
      context.onOutput("Fetching submodules\n");
      await git(
        ["submodule", "update", "--init", "--recursive", "--depth", "1"],
        "Fetching submodules",
        false,
        true,
      );
    }
    const commit = await git(["rev-parse", "HEAD"], "Reading the commit", true);
    const subject = await git(["log", "-1", "--format=%s"], "Reading the commit", true);
    context.onOutput(`Checked out ${commit.slice(0, 7)}: ${subject}\n`);
    // The history isn't needed to build; it only makes the build context bigger.
    await rm(join(source, ".git"), { recursive: true, force: true });
    for (const link of await dropOutsideLinks(source)) {
      context.onOutput(`Left out ${link}: it is a link to somewhere outside the repository.\n`);
    }
    return { commit, subject, branch: spec.branch };
  } finally {
    if (keyFile) await rm(keyFile, { force: true });
  }
}
