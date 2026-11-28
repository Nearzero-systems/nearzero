import type { AccessScope, Member, WorkspaceInvitation } from "./data/types.ts";
import { relativeTime } from "./time.ts";
import { CAPABILITIES, CAPABILITY_KEYS, type Capability, ROLE_LABELS } from "./vocabulary.ts";

/**
 * The short sentences of Members & access (spec 04 4.7): policy cards, access notes under roles,
 * "From <policy>" marks and invitation statuses.
 */

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Capabilities in catalog order, so every list reads the same way. */
export function orderedCapabilities(capabilities: readonly Capability[]): Capability[] {
  const set = new Set(capabilities);
  return CAPABILITY_KEYS.filter((key) => set.has(key));
}

/** "Can": the first two capabilities and "and N more", or "No extra permissions". */
export function capabilitySummary(capabilities: readonly Capability[]): string {
  // "Create environments, create services": one sentence, so only the first is capitalised.
  const labels = orderedCapabilities(capabilities).map((key, index) => {
    const label: string = CAPABILITIES[key].label;
    return index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1);
  });
  if (labels.length === 0) return "No extra permissions";
  if (labels.length <= 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} and ${labels.length - 2} more`;
}

/** "All projects", "No projects", or "N projects, M environments". */
export function projectScopeSummary(scope: AccessScope): string {
  if (scope.allProjects) return "All projects";
  if (scope.projectIds.length === 0) return "No projects";
  const projects = plural(scope.projectIds.length, "project");
  return scope.environmentIds.length > 0
    ? `${projects}, ${plural(scope.environmentIds.length, "environment")}`
    : projects;
}

export function serverScopeSummary(scope: AccessScope): string {
  if (scope.allServers) return "All servers";
  if (scope.serverIds.length === 0) return "No servers";
  return plural(scope.serverIds.length, "server");
}

/** Git accounts shared with everyone are always usable, so "none" reads "Shared Git accounts". */
export function gitScopeSummary(scope: AccessScope): string {
  if (scope.allGitAccounts) return "All Git accounts";
  if (scope.gitAccountIds.length === 0) return "Shared Git accounts";
  return plural(scope.gitAccountIds.length, "Git account");
}

/** "Given to A, B, C and N more" or "Not given to anyone yet." */
export function holdersSummary(holders: readonly { name: string }[]): string {
  const names = holders.map((holder) => holder.name);
  if (names.length === 0) return "Not given to anyone yet.";
  if (names.length <= 3) return `Given to ${joinNames(names)}`;
  return `Given to ${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** Where a grant comes from: "From A", "From A and B", "From A, B and N more". */
export function fromLabel(names: readonly string[]): string {
  const list = names.filter(Boolean);
  if (list.length === 0) return "";
  if (list.length <= 2) return `From ${joinNames(list)}`;
  return `From ${list.slice(0, 2).join(", ")} and ${list.length - 2} more`;
}

/** The note under a member's role: "Everything", their policies, or what's granted directly. */
export function accessNote(member: Pick<Member, "role" | "access">): string {
  if (member.role !== "member" || member.access.everything) return "Everything";
  const names = member.access.policies.map((policy) => policy.name);
  if (names.length === 0) return "Only what's granted to them";
  return member.access.direct ? `${joinNames(names)}, and direct grants` : joinNames(names);
}

export function roleLabel(role: keyof typeof ROLE_LABELS): string {
  return ROLE_LABELS[role];
}

/** The invitations table's status: "Pending · Expires in 6 days" or "Expired 2 days ago". */
export function invitationStatus(
  invitation: Pick<WorkspaceInvitation, "state" | "expiresAt">,
  now: Date = new Date(),
): { label: "Pending" | "Expired"; detail: string } {
  const expires = new Date(invitation.expiresAt);
  const expired = invitation.state === "expired" || expires.getTime() <= now.getTime();
  return expired
    ? { label: "Expired", detail: `Expired ${relativeTime(expires, now)}` }
    : { label: "Pending", detail: `Expires ${relativeTime(expires, now)}` };
}

/**
 * "Sent 3 hours ago" (spec 4.7 invitations table, 21.10): when it was last emailed, or when it was created
 * for a link that was only copied.
 */
export function invitationSent(
  invitation: Pick<WorkspaceInvitation, "lastEmailedAt" | "createdAt">,
  now: Date = new Date(),
): string {
  return `Sent ${relativeTime(new Date(invitation.lastEmailedAt ?? invitation.createdAt), now)}`;
}
