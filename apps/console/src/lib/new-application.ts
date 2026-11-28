/**
 * The new-application page's rules (spec 06 6.1): which public repository addresses are
 * accepted, what the app is called by default, and the hostname preview.
 */

export const GIT_URL_MESSAGE = "Enter a valid public Git URL (HTTPS or git@host:owner/repo).";
export const PORT_MESSAGE = "Enter a valid service port (1–65535).";
export const IMAGE_SPACES_MESSAGE =
  'Enter an image with no spaces, like "nginx:alpine" or "ghcr.io/acme/api:1.2.0".';

const HTTPS = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[^\s?#]+?(?:\.git)?\/?$/;
const SSH = /^git@[A-Za-z0-9.-]+:[^\s/]+\/[^\s]+?(?:\.git)?$/;

/** Any host over HTTPS with an owner and a repository, or git@host:owner/repo. */
export function isPublicGitUrl(value: string): boolean {
  const url = value.trim();
  if (SSH.test(url)) return true;
  if (!HTTPS.test(url)) return false;
  try {
    const parsed = new URL(url);
    // Credentials inside the address are never accepted (spec 06 6.3).
    if (parsed.username || parsed.password) return false;
    return parsed.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

/** The repository's own name, for the display name the form starts with. */
export function repositoryName(value: string): string {
  const url = value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const last = url.split(/[/:]/).pop() ?? "";
  return last;
}

export function portProblem(value: string): string | null {
  if (!/^\d+$/.test(value.trim())) return PORT_MESSAGE;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? null : PORT_MESSAGE;
}

export function imageProblem(value: string): string | null {
  return /\s/.test(value.trim()) ? IMAGE_SPACES_MESSAGE : null;
}
