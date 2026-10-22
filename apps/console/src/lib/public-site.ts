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
		description:
			"No Docker host. No database on your VPS. Nearzero runs both on Linux you own.",
	},
	{
		href: publicSiteLinks.compareCoolify,
		competitor: "Coolify",
		label: "Nearzero vs Coolify",
		description:
			"Placement, optional CoreDNS, and a locked-down Agent — not experimental multi-server.",
	},
	{
		href: publicSiteLinks.compareNetlify,
		competitor: "Netlify",
		label: "Nearzero vs Netlify",
		description:
			"Netlify is an edge for sites. Nearzero is a control plane for your VPS.",
	},
] as const;

export const docsNavigation = [
	{
		href: publicSiteLinks.docs,
		label: "Documentation home",
		description: "Install the control plane, then take Git to HTTPS",
	},
	{
		href: publicSiteLinks.architecture,
		label: "Architecture",
		description: "Your servers run the apps. Nearzero is the control plane.",
	},
	{
		href: publicSiteLinks.selfHosting,
		label: "Self-host Nearzero",
		description: "Install with one command, sign in, add your domain",
	},
	{
		href: publicSiteLinks.remoteServers,
		label: "Remote servers",
		description: "Add a Linux VPS and send traffic straight to it",
	},
	{
		href: publicSiteLinks.domainsAndHttps,
		label: "Domains and HTTPS",
		description: "Point the hostname at the server that runs the app",
	},
	{
		href: publicSiteLinks.agentSafety,
		label: "Agent safety",
		description: "It can see your infra. Production writes start off.",
	},
] as const;

export const docsNavigationGroups = [
	{
		id: "start",
		label: "Getting started",
		items: [
			{ href: publicSiteLinks.docs, label: "Introduction" },
			{ href: publicSiteLinks.architecture, label: "Architecture" },
			{ href: publicSiteLinks.selfHosting, label: "Self-host Nearzero" },
		],
	},
	{
		id: "operate",
		label: "Operate",
		items: [
			{ href: publicSiteLinks.remoteServers, label: "Remote servers" },
			{ href: publicSiteLinks.domainsAndHttps, label: "Domains and HTTPS" },
		],
	},
	{
		id: "agent",
		label: "Agent",
		items: [{ href: publicSiteLinks.agentSafety, label: "Agent safety" }],
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
		],
	},
	{
		title: "Documentation",
		links: [
			{ label: "Overview", href: publicSiteLinks.docs },
			{ label: "Self-hosting", href: publicSiteLinks.selfHosting },
		],
	},
	{
		title: "Compare",
		links: [
			{ label: "All comparisons", href: publicSiteLinks.compare },
			{ label: "vs Vercel", href: publicSiteLinks.compareVercel },
			{ label: "vs Coolify", href: publicSiteLinks.compareCoolify },
			{ label: "vs Netlify", href: publicSiteLinks.compareNetlify },
		],
	},
	{
		title: "Help",
		links: [
			{ label: "GitHub", href: publicSiteLinks.github },
			{ label: "Issues", href: publicSiteLinks.issues },
			{ label: "Support", href: publicSiteLinks.support },
		],
	},
] as const;

export const publicFaqGroups = [
	{
		title: "General",
		items: [
			{
				question: "What is Nearzero?",
				answer:
					"Nearzero is open-source software you install on your own Linux server. You use it to deploy apps and databases to that server, or to other servers you add.",
			},
			{
				question: "Is Nearzero a self-hosted Vercel alternative?",
				answer:
					"Yes, if you want to deploy from Git on machines you own. You still run those machines. Nearzero does not give you Vercel’s global CDN.",
			},
			{
				question: "Is Nearzero free and open source?",
				answer:
					"Yes. You can self-host the Community edition for free. You still pay for your VPS, storage, and domain.",
			},
			{
				question: "How is Nearzero different from Coolify?",
				answer:
					"Both run on your VPS. Nearzero keeps apps, databases, extra servers, optional DNS, HTTPS, and a locked-down Agent in one control plane.",
			},
		],
	},
	{
		title: "Platform",
		items: [
			{
				question: "How do I install Nearzero on a VPS?",
				answer:
					"Use a dedicated Linux VPS. Download the installer, check the SHA-256 checksum, read the script, then run it. Finish setup on your own HTTPS admin URL.",
			},
			{
				question: "What applications and databases can I deploy?",
				answer:
					"Most container apps, including Node, Python, Go, PHP, and Ruby. Databases include Postgres, MySQL, MariaDB, MongoDB, Redis, and libSQL. Docker Compose works too.",
			},
			{
				question:
					"Does Nearzero support custom domains and Let’s Encrypt HTTPS?",
				answer:
					"Yes. Point your domain at the server. Nearzero uses Traefik and Let’s Encrypt. Ports 80 and 443 need to be open.",
			},
			{
				question: "Can Nearzero deploy to remote servers?",
				answer:
					"Yes. Keep Nearzero on one server, add other Linux servers over SSH, and pick where each app runs. Public traffic can go straight to that server.",
			},
		],
	},
	{
		title: "Operations",
		items: [
			{
				question: "Can the Agent change production without permission?",
				answer:
					"No. The Agent can read logs and project state, but it can only make a change if your account is allowed to. Production changes stay off until you turn that on.",
			},
			{
				question: "Do I still have to manage the servers myself?",
				answer:
					"Yes. You still patch, back up, and size the VPS. Nearzero builds, deploys, and routes. You keep the servers healthy.",
			},
		],
	},
] as const;

export type PublicFaq = { question: string; answer: string };

export const publicFaqs: PublicFaq[] = publicFaqGroups.flatMap(
	(group): readonly PublicFaq[] => group.items,
);
