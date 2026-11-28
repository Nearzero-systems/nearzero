import type { DeploymentQuery } from "./data/operations-types.ts";

/**
 * The Deployments page's address and filters (spec 11.1): search, status, type, page size (10,
 * 25, 50 by default, or 100) and the page, read from and written to the address so a filtered
 * view can be shared.
 */

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 50;

export const TYPE_FILTERS = [
  { value: "all", label: "All types" },
  { value: "application", label: "Application" },
  { value: "compose", label: "Compose" },
  { value: "database", label: "Database" },
] as const;

const STATUSES = [
  "all",
  "queued",
  "building",
  "active",
  "previous",
  "not_running",
  "failed",
  "cancelled",
  "removed",
];

export function deploymentsQuery(params: URLSearchParams): DeploymentQuery {
  const search = (params.get("q") ?? "").trim().slice(0, 200);
  const status = params.get("status") ?? "all";
  const type = params.get("type") ?? "all";
  const size = Number(params.get("pageSize"));
  const page = Number(params.get("page"));
  return {
    search: search || undefined,
    status: STATUSES.includes(status) ? status : "all",
    type: TYPE_FILTERS.some((item) => item.value === type) ? type : "all",
    pageSize: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

/** The address of another page of the same view; filters at their defaults stay out. */
export function pageHref(base: string, query: DeploymentQuery, page: number): string {
  const params = new URLSearchParams();
  if (query.search) params.set("q", query.search);
  if (query.status && query.status !== "all") params.set("status", query.status);
  if (query.type && query.type !== "all") params.set("type", query.type);
  if (query.pageSize && query.pageSize !== DEFAULT_PAGE_SIZE)
    params.set("pageSize", String(query.pageSize));
  if (page > 1) params.set("page", String(page));
  const text = params.toString();
  return text ? `${base}?${text}` : base;
}
