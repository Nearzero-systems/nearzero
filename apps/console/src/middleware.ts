import type { MiddlewareHandler } from "astro";
import { sanitizeAuthCallbackPath } from "./lib/auth-callback-url";
import { getSession } from "./lib/backendProxy";
import { parseInvitationCallback } from "./lib/invitation-routes";
import {
	invitationPathFromToken,
	isInviteMemberSetupMode,
	isWorkspaceSetupMode,
	registerOnboardingResumePath,
	registerPathForSession,
	registerStepFromUrl,
} from "./lib/onboarding-gates";
import {
	isDashboardRootPath,
	isOrgScopedDashboardPath,
	isReservedOrgSegment,
	normalizeDashboardPath,
	orgDashboardPath,
} from "./lib/org-routes";
import { consolePathUsesSession } from "./lib/publicRoutes";
import {
	isOnboardingRegisterStep,
	parseRegisterStep,
} from "./lib/register-onboarding";
import { fetchRegistrationStatusServer } from "./lib/registration-status-server";
import { createServerTrpcClient } from "./lib/server-api";
import {
	fetchActiveOrganization,
	fetchOnboardingStatus,
} from "./lib/trpc-server";

/** Internal header set on org-scoped dashboard rewrites to prevent redirect loops. */
export const ORG_DASHBOARD_REWRITE_HEADER = "x-nearzero-org-dashboard-rewrite";

function isOrgDashboardRewrite(request: Request) {
	return request.headers.get(ORG_DASHBOARD_REWRITE_HEADER) === "1";
}

function dashboardPathForOrganization(
	org: { slug?: string | null } | null,
	fallback = "/dashboard/agent",
) {
	return org?.slug ? orgDashboardPath(org.slug, fallback) : fallback;
}

async function isPendingInvitationCallback(request: Request, token: string) {
	try {
		const api = createServerTrpcClient(request);
		const invitation = await api.user.getUserByToken.query({ token });
		return Boolean(
			invitation && !invitation.isExpired && invitation.status === "pending",
		);
	} catch {
		return false;
	}
}

function withPrivateNoStore(response: Response) {
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "private, no-store, must-revalidate");
	headers.set("Vary", "Cookie");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

// The Get started guide is hidden for now, so every sign-in lands on the Agent.
function dashboardLandingPath(orgSlug?: string | null) {
	return orgSlug?.trim()
		? orgDashboardPath(orgSlug.trim(), "/dashboard/agent")
		: "/dashboard/agent";
}

async function resolvePostAuthRedirect(
	request: Request,
	site: URL,
	fallback: string,
) {
	const callbackPath = sanitizeAuthCallbackPath(
		site.searchParams.get("callbackUrl"),
		site,
		"",
	);
	const callbackInvitationToken = parseInvitationCallback(callbackPath);
	if (
		callbackInvitationToken &&
		(await isPendingInvitationCallback(request, callbackInvitationToken))
	) {
		return invitationPathFromToken(callbackInvitationToken);
	}

	const onboardingStatus = await fetchOnboardingStatus(request);
	if (onboardingStatus?.pendingInvitationId) {
		return invitationPathFromToken(onboardingStatus.pendingInvitationId);
	}

	const activeOrg = await fetchActiveOrganization(request);
	if (onboardingStatus?.complete === false) {
		return registerOnboardingResumePath(onboardingStatus);
	}

	const landing = dashboardPathForOrganization(activeOrg, fallback);
	return callbackInvitationToken ? landing : callbackPath || landing;
}

async function guardDashboardAccess(
	request: Request,
	path: string,
	session: { user: unknown } | null,
) {
	if (!session?.user) {
		const dest = `${path}${new URL(request.url).search}`;
		return new Response(null, {
			status: 302,
			headers: {
				Location: `/login?callbackUrl=${encodeURIComponent(dest)}`,
			},
		});
	}

	const onboardingStatus = await fetchOnboardingStatus(request);
	if (onboardingStatus?.pendingInvitationId) {
		return new Response(null, {
			status: 302,
			headers: {
				Location: invitationPathFromToken(onboardingStatus.pendingInvitationId),
			},
		});
	}

	if (onboardingStatus?.complete === false) {
		return new Response(null, {
			status: 302,
			headers: {
				Location: registerOnboardingResumePath(onboardingStatus),
			},
		});
	}

	return null;
}

export const onRequest: MiddlewareHandler = async (context, next) => {
	const path = context.url.pathname;

	if (path === "/") {
		const rootSession = await getSession(context.request);
		if (rootSession?.user) {
			return context.redirect(
				await resolvePostAuthRedirect(
					context.request,
					context.url,
					"/dashboard/agent",
				),
			);
		}
		return context.redirect("/login");
	}

	// The browser setup wizard was retired: the owner is created on the server.
	if (path === "/setup" || path.startsWith("/setup/")) {
		return context.redirect("/login");
	}

	if (path === "/register") {
		const inviteToken = context.url.searchParams.get("token")?.trim() || "";
		// Without public signup, /register only serves invitations. Signed-in
		// users (including someone mid-onboarding) are routed by the
		// session-aware /register branch below; sending them to /login would
		// bounce straight back to /register?step=… in a loop.
		if (!inviteToken) {
			const registration = await fetchRegistrationStatusServer();
			if (
				registration &&
				!registration.normalSignupAllowed &&
				!(await getSession(context.request))?.user
			) {
				return context.redirect("/login");
			}
		}
	}

	if (
		path === "/register" &&
		context.url.searchParams.get("step")?.toLowerCase() === "verify"
	) {
		return context.redirect("/register");
	}

	if (
		path === "/register" &&
		context.url.searchParams.get("step")?.toLowerCase() === "source"
	) {
		return context.redirect("/register?step=profile");
	}

	const inviteTokenFromUrl =
		context.url.searchParams.get("token")?.trim() || "";
	const registerStep = registerStepFromUrl(context.url);
	if (
		path === "/register" &&
		inviteTokenFromUrl &&
		isOnboardingRegisterStep(
			parseRegisterStep(context.url.searchParams.get("step")),
		) &&
		!isWorkspaceSetupMode(context.url)
	) {
		return context.redirect(invitationPathFromToken(inviteTokenFromUrl));
	}

	const { orgSlug, dashboardPath } = normalizeDashboardPath(path);
	if (dashboardPath === "/dashboard/get-started") {
		return context.redirect(dashboardLandingPath(orgSlug));
	}
	const isOrgDashboard = isOrgScopedDashboardPath(path);
	const usesSession = consolePathUsesSession(path) || isOrgDashboard;

	const session = usesSession ? await getSession(context.request) : null;

	if (path === "/login" && session?.user) {
		return context.redirect(
			await resolvePostAuthRedirect(
				context.request,
				context.url,
				"/dashboard/agent",
			),
		);
	}

	if (path === "/register" && session?.user) {
		const onboardingStatus = await fetchOnboardingStatus(context.request);
		const redirectTo = registerPathForSession(registerStep, onboardingStatus, {
			invitationToken: inviteTokenFromUrl || null,
			workspaceSetupMode: isWorkspaceSetupMode(context.url),
			inviteMemberSetupMode: isInviteMemberSetupMode(context.url),
		});
		if (redirectTo) {
			return context.redirect(redirectTo);
		}
	}

	if (isOrgDashboard && orgSlug) {
		if (isReservedOrgSegment(orgSlug)) {
			return context.redirect("/dashboard/agent");
		}

		if (isDashboardRootPath(path)) {
			const blocked = await guardDashboardAccess(
				context.request,
				"/dashboard/agent",
				session,
			);
			if (blocked) return blocked;
			const activeOrg = await fetchActiveOrganization(context.request);
			return context.redirect(
				dashboardLandingPath(activeOrg?.slug ?? orgSlug) + context.url.search,
			);
		}

		if (dashboardPath === "/dashboard/home") {
			const blocked = await guardDashboardAccess(
				context.request,
				"/dashboard/agent",
				session,
			);
			if (blocked) return blocked;
			const activeOrg = await fetchActiveOrganization(context.request);
			return context.redirect(
				dashboardLandingPath(activeOrg?.slug ?? orgSlug) + context.url.search,
			);
		}

		const blocked = await guardDashboardAccess(
			context.request,
			dashboardPath,
			session,
		);
		if (blocked) return blocked;

		const activeOrg = await fetchActiveOrganization(context.request);
		if (activeOrg?.slug && activeOrg.slug !== orgSlug) {
			return context.redirect(
				orgDashboardPath(activeOrg.slug, dashboardPath) + context.url.search,
			);
		}

		const rewriteUrl = new URL(dashboardPath + context.url.search, context.url);
		const rewriteHeaders = new Headers(context.request.headers);
		rewriteHeaders.set(ORG_DASHBOARD_REWRITE_HEADER, "1");
		const rewriteRequest = new Request(rewriteUrl, {
			method: context.request.method,
			headers: rewriteHeaders,
		});
		const response = await context.rewrite(rewriteRequest);
		if (response && dashboardPath.startsWith("/dashboard")) {
			return withPrivateNoStore(response);
		}
		return response;
	}

	if (path.startsWith("/dashboard")) {
		if (isOrgDashboardRewrite(context.request)) {
			const blocked = await guardDashboardAccess(
				context.request,
				path,
				session,
			);
			if (blocked) return blocked;

			const response = await next();
			if (response && path.startsWith("/dashboard")) {
				return withPrivateNoStore(response);
			}
			return response;
		}

		if (isDashboardRootPath(path)) {
			const blocked = await guardDashboardAccess(
				context.request,
				"/dashboard/agent",
				session,
			);
			if (blocked) return blocked;

			const activeOrg = await fetchActiveOrganization(context.request);
			return context.redirect(
				dashboardLandingPath(activeOrg?.slug) + context.url.search,
			);
		}

		if (path === "/dashboard/home") {
			const blocked = await guardDashboardAccess(
				context.request,
				"/dashboard/agent",
				session,
			);
			if (blocked) return blocked;

			const activeOrg = await fetchActiveOrganization(context.request);
			return context.redirect(
				dashboardLandingPath(activeOrg?.slug) + context.url.search,
			);
		}

		const blocked = await guardDashboardAccess(context.request, path, session);
		if (blocked) return blocked;

		const activeOrg = await fetchActiveOrganization(context.request);
		if (activeOrg?.slug) {
			return context.redirect(
				orgDashboardPath(activeOrg.slug, path) + context.url.search,
			);
		}
	}

	const response = await next();
	if (response && path.startsWith("/dashboard")) {
		return withPrivateNoStore(response);
	}
	return response;
};
