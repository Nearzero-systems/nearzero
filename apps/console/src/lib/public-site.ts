import {
	NEARZERO_GITHUB_URL,
	NEARZERO_ISSUES_URL,
	NEARZERO_SUPPORT_URL,
} from "@/lib/branding";

const DEFAULT_PUBLIC_SITE_URL = "https://nearzero.dev";

export const PUBLIC_SITE_DESCRIPTION =
	"Nearzero is an open-source, self-hosted control plane for deploying and operating applications, databases, Compose, remote servers, domains, and HTTPS.";

export function publicSiteUrl(pathname = "/"): URL {
	const configured = import.meta.env.PUBLIC_NEARZERO_SITE_URL?.trim();
	return new URL(pathname, configured || DEFAULT_PUBLIC_SITE_URL);
}

export const publicSiteLinks = {
	home: "/docs",
	docs: "/docs",
	compare: "/compare",
	compareVercel: "/compare/vercel",
	compareCoolify: "/compare/coolify",
	compareDokploy: "/compare/dokploy",
	compareNetlify: "/compare/netlify",
	selfHosting: "/docs/self-hosting",
	architecture: "/docs/architecture",
	remoteServers: "/docs/remote-servers",
	domainsAndHttps: "/docs/domains-and-https",
	agentSafety: "/docs/agent-safety",
	signIn: "/login",
	github: NEARZERO_GITHUB_URL,
	issues: NEARZERO_ISSUES_URL,
	support: NEARZERO_SUPPORT_URL,
} as const;

export const comparisonNavigation = [
	{
		href: publicSiteLinks.compareVercel,
		competitor: "Vercel",
		label: "Nearzero vs Vercel",
		description: "Compare deployment workflows and infrastructure control",
	},
	{
		href: publicSiteLinks.compareCoolify,
		competitor: "Coolify",
		label: "Nearzero vs Coolify",
		description: "Compare self-hosting, domains, and operations",
	},
	{
		href: publicSiteLinks.compareDokploy,
		competitor: "Dokploy",
		label: "Nearzero vs Dokploy",
		description: "Compare server management and deployment workflows",
	},
	{
		href: publicSiteLinks.compareNetlify,
		competitor: "Netlify",
		label: "Nearzero vs Netlify",
		description: "Compare application delivery and infrastructure ownership",
	},
] as const;

export const docsNavigation = [
	{
		href: publicSiteLinks.docs,
		label: "Documentation home",
		description: "Choose the right deployment path",
	},
	{
		href: publicSiteLinks.architecture,
		label: "Architecture",
		description: "Control plane, your servers, and guardrails",
	},
	{
		href: publicSiteLinks.selfHosting,
		label: "Self-host Nearzero",
		description: "Install, update, back up, and restore",
	},
	{
		href: publicSiteLinks.remoteServers,
		label: "Remote servers",
		description: "Connect and secure workload hosts",
	},
	{
		href: publicSiteLinks.domainsAndHttps,
		label: "Domains and HTTPS",
		description: "Delegate DNS and route with Traefik",
	},
	{
		href: publicSiteLinks.agentSafety,
		label: "Agent safety",
		description: "Understand permissions and secret boundaries",
	},
] as const;

export const publicFooterGroups = [
	{
		title: "Product",
		links: [
			{ label: "Architecture", href: publicSiteLinks.architecture },
			{ label: "Remote servers", href: publicSiteLinks.remoteServers },
			{ label: "Domains and HTTPS", href: publicSiteLinks.domainsAndHttps },
			{ label: "Agent safety", href: publicSiteLinks.agentSafety },
			{ label: "Sign in", href: publicSiteLinks.signIn },
		],
	},
	{
		title: "Resources",
		links: [
			{ label: "Documentation", href: publicSiteLinks.docs },
			{ label: "Compare", href: publicSiteLinks.compare },
			{ label: "GitHub", href: publicSiteLinks.github },
			{ label: "Issues", href: publicSiteLinks.issues },
			{ label: "Support", href: publicSiteLinks.support },
		],
	},
	{
		title: "Get started",
		links: [
			{ label: "Install Nearzero", href: publicSiteLinks.selfHosting },
			{ label: "Architecture", href: publicSiteLinks.architecture },
			{ label: "Remote servers", href: publicSiteLinks.remoteServers },
			{ label: "Managed DNS", href: publicSiteLinks.domainsAndHttps },
			{ label: "Agent safety", href: publicSiteLinks.agentSafety },
		],
	},
] as const;
