import { createHmac } from "node:crypto";
import type { GitProviderKind } from "@nearzero/shared";
import { constantTimeEqual } from "../security/tokens.ts";

/**
 * Checking that a push really came from the Git host (spec 6.6, 16.2, 24 G4, G7): every check
 * runs on the exact bytes that arrived, before anything parses them, and compares in constant
 * time.
 * - GitHub (the app's webhook): X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secret, body).
 * - Gitea: X-Gitea-Signature = hex HMAC-SHA256(secret, body) (or the GitHub-style header).
 * - Bitbucket Cloud: X-Hub-Signature = "sha256=" + HMAC-SHA256(secret, body).
 * - GitLab: X-Gitlab-Token carries the webhook's secret token itself.
 */

export function hmacSha256Hex(secret: string, body: Uint8Array): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function prefixed(header: string | null, prefix: string): string | null {
  if (!header) return null;
  const value = header.trim();
  return value.toLowerCase().startsWith(prefix) ? value.slice(prefix.length).toLowerCase() : null;
}

function matchesHex(secret: string, body: Uint8Array, given: string | null): boolean {
  const expected = hmacSha256Hex(secret, body);
  // Compare even when the header is missing, so a missing header costs the same time.
  const ok = constantTimeEqual(expected, given ?? "0".repeat(expected.length));
  return ok && given !== null && secret !== "";
}

export function verifyGithubSignature(
  secret: string,
  body: Uint8Array,
  header: string | null,
): boolean {
  return matchesHex(secret, body, prefixed(header, "sha256="));
}

export function verifyBitbucketSignature(
  secret: string,
  body: Uint8Array,
  header: string | null,
): boolean {
  return matchesHex(secret, body, prefixed(header, "sha256="));
}

export function verifyGiteaSignature(secret: string, body: Uint8Array, headers: Headers): boolean {
  const plain = headers.get("x-gitea-signature") ?? headers.get("x-gogs-signature");
  if (plain) return matchesHex(secret, body, plain.trim().toLowerCase());
  return matchesHex(secret, body, prefixed(headers.get("x-hub-signature-256"), "sha256="));
}

export function verifyGitlabToken(secret: string, header: string | null): boolean {
  const ok = constantTimeEqual(secret, header ?? "");
  return ok && header !== null && secret !== "";
}

/** Which host a webhook call says it comes from, by its event headers (Gitea first: it also sends GitHub's). */
export function pushOrigin(headers: Headers): GitProviderKind | null {
  if (headers.has("x-gitea-event") || headers.has("x-gogs-event")) return "gitea";
  if (headers.has("x-gitlab-event")) return "gitlab";
  if (headers.has("x-event-key") && (headers.has("x-hook-uuid") || headers.has("x-request-uuid"))) {
    return "bitbucket";
  }
  if (headers.has("x-github-event")) return "github";
  return null;
}

/** The provider's check for one call, by kind. */
export function verifyProviderCall(
  kind: Exclude<GitProviderKind, "github">,
  secret: string,
  body: Uint8Array,
  headers: Headers,
): boolean {
  switch (kind) {
    case "gitlab":
      return verifyGitlabToken(secret, headers.get("x-gitlab-token"));
    case "gitea":
      return verifyGiteaSignature(secret, body, headers);
    case "bitbucket":
      return verifyBitbucketSignature(secret, body, headers.get("x-hub-signature"));
  }
}
