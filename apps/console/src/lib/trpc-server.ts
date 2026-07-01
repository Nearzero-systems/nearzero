import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { joinBackendUrl } from "./backendProxy";

/** Untyped proxy to nearzero `appRouter` over HTTP (SSR / Astro frontmatter). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createBackendTrpcClient(cookie: string): any {
	return createTRPCProxyClient<any>({
		links: [
			httpBatchLink({
				url: joinBackendUrl("/api/trpc"),
				headers: () => (cookie ? { cookie } : {}),
				transformer: superjson,
			}),
		],
	});
}

export function getRequestCookie(request: Request) {
	return request.headers.get("cookie") ?? "";
}

export async function trpcQuery<T>(
	request: Request,
	path: string,
	input?: unknown,
): Promise<T | null> {
	const cookie = getRequestCookie(request);
	if (!cookie) return null;
	try {
		const client = createBackendTrpcClient(cookie);
		const [router, procedure] = path.split(".");
		if (!router || !procedure) return null;
		const target = (client as Record<string, Record<string, { query: (i?: unknown) => Promise<T> }>>)[
			router
		]?.[procedure];
		if (!target) return null;
		return await target.query(input);
	} catch {
		return null;
	}
}

export type OnboardingStatus = {
	complete: boolean;
	profileComplete: boolean;
	firstName: string;
	organizationName: string;
	pendingInvitationId?: string | null;
	needsWorkspaceSetup?: boolean;
	needsInviteMemberSetup?: boolean;
	inviteMemberProfileComplete?: boolean;
	organizationSlug?: string | null;
};

export type ActiveOrganization = {
	id: string;
	name: string;
	slug: string | null;
};

export async function fetchOnboardingStatus(
	request: Request,
): Promise<OnboardingStatus | null> {
	return trpcQuery<OnboardingStatus>(request, "user.onboardingStatus");
}

export async function fetchActiveOrganization(
	request: Request,
): Promise<ActiveOrganization | null> {
	return trpcQuery<ActiveOrganization | null>(request, "organization.active");
}

export async function fetchOnboardingComplete(
	request: Request,
): Promise<boolean | null> {
	const result = await fetchOnboardingStatus(request);
	if (result == null) return null;
	return Boolean(result.complete);
}
