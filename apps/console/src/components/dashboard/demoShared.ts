export const demoSectionOrder = [
  "story",
  "deployments",
  "logs",
  "projects",
  "domains",
  "storage",
  "cron-jobs",
  "tasks",
  "queues",
  "api-keys",
  "help",
  "plan",
] as const;

export type DemoSectionKey = (typeof demoSectionOrder)[number];

export const demoSectionKeys = new Set<string>(demoSectionOrder);

export const demoSectionMeta: Record<
  DemoSectionKey,
  {
    eyebrow: string;
    title: string;
    description: string;
    ctaLabel?: string;
    ctaHref?: string;
  }
> = {
  story: {
    eyebrow: "Story",
    title: "Welcome to Nearzero.",
    description:
      "Start with projects, runtime delivery, and operational controls from one workspace.",
    ctaLabel: "Open projects",
    ctaHref: "/dashboard/home?section=projects",
  },
  deployments: {
    eyebrow: "Deployments",
    title: "Deployment history.",
    description:
      "Review recent build and rollout activity from one place.",
  },
  logs: {
    eyebrow: "Logs",
    title: "Inspect runtime activity.",
    description:
      "Keep rollout visibility, system notices, and edge events close to the release flow.",
  },
  projects: {
    eyebrow: "Projects",
    title: "Import your project to get started.",
    description:
      "Connect a repository from GitHub, GitLab, or Bitbucket to create your first Nearzero project.",
  },
  domains: {
    eyebrow: "Domains",
    title: "Route traffic with confidence.",
    description:
      "Review attached domains, routing state, and the deployment currently serving each hostname.",
  },
  storage: {
    eyebrow: "Storage",
    title: "Keep object delivery organized.",
    description:
      "Watch Glacier usage, object counts, and delivery footprint per project.",
  },
  "cron-jobs": {
    eyebrow: "Cron jobs",
    title: "Schedule background work.",
    description:
      "Define recurring automation windows and keep important maintenance on a fixed cadence.",
  },
  tasks: {
    eyebrow: "Tasks",
    title: "Coordinate background jobs.",
    description:
      "Track asynchronous work, retries, ownership, and completion without leaving the console.",
  },
  queues: {
    eyebrow: "Queues",
    title: "Monitor queue throughput.",
    description:
      "See backlog pressure, consumer health, and drain times before work starts piling up.",
  },
  "api-keys": {
    eyebrow: "API keys",
    title: "Control platform access.",
    description:
      "Issue scoped keys for automation, delivery tooling, and workspace integrations.",
  },
  help: {
    eyebrow: "Help",
    title: "Keep the team close to guidance.",
    description:
      "Surface the most useful setup, deployment, and runtime references inside the workspace flow.",
  },
  plan: {
    eyebrow: "Plan",
    title: "See what unlocks next.",
    description:
      "Compare your current plan to the controls needed for larger delivery and platform teams.",
    ctaLabel: "Upgrade plan",
    ctaHref: "/dashboard/home?section=plan",
  },
};

export const cardClass = "rounded-md bg-white p-4";
export const mutedCardClass = "rounded-md bg-[#f7f7f8] p-4";
export const badgeClass =
  "inline-flex items-center rounded-md border border-[#d9dbe3] bg-[#f7f7f8] px-2 py-1 text-xs text-[#6b7280]";
export const buttonClass =
  "inline-flex items-center justify-center rounded-md border border-[#d9dbe3] bg-[#f7f7f8] px-2 py-1 text-xs text-[#111827] transition-colors hover:bg-white";

/**
 * Single canonical spinner (`animate-spin`) for dashboard loading states.
 * Use {@link dashboardLoadingSpinnerCenteredHtml}, {@link dashboardLoadingSpinnerMinimalHtml}, or {@link dashboardSpinnerSvgHtml}.
 */
const DASHBOARD_SPINNER_SVG = `<svg viewBox="0 0 24 24" class="h-5 w-5 animate-spin" aria-hidden="true"><circle cx="12" cy="12" r="9" class="opacity-20" stroke="currentColor" stroke-width="2" fill="none"></circle><path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>`;

/** Centered block: repo list loading, full-screen project loading, etc. */
export function dashboardLoadingSpinnerCenteredHtml(): string {
  return `<div class="flex justify-center px-4 py-10" role="status" aria-live="polite"><span class="sr-only">Loading</span><div class="inline-flex h-10 w-10 items-center justify-center rounded-md bg-[#f7f7f8] text-[#6b7280]">${DASHBOARD_SPINNER_SVG}</div></div>`;
}

/** Spinner only (`animate-spin`) — vertically/horizontally centered in the repo panel. */
export function dashboardLoadingSpinnerMinimalHtml(): string {
  return `<div class="flex min-h-[min(280px,42vh)] w-full items-center justify-center text-[#6b7280]" role="status" aria-live="polite"><span class="sr-only">Loading</span>${DASHBOARD_SPINNER_SVG}</div>`;
}

/** SVG only — compact placements (e.g. header badge). */
export function dashboardSpinnerSvgHtml(): string {
  return DASHBOARD_SPINNER_SVG;
}

export function statusPillClass(status: string | undefined) {
  const value = String(status || "").toLowerCase();
  if (value === "success" || value === "ready") {
    return "border-[#d7ead8] bg-[#f3faf3] text-[#325c35]";
  }
  if (value === "building" || value === "deploying" || value === "processing") {
    return "border-[#f3dfb0] bg-[#fff8ea] text-[#925f00]";
  }
  if (value === "failed") {
    return "border-[#f5c8c8] bg-[#fff1f1] text-[#9f3131]";
  }
  if (value === "queued") {
    return "border-[#dbe4f0] bg-[#f6f9fc] text-[#4f647d]";
  }
  return "border-[#d9dbe3] bg-[#fafafa] text-[#6b7280]";
}
