export const comparisonReviewDate = "July 28, 2026";
export const comparisonReviewDateIso = "2026-07-28";

export type ComparisonCategory = "managed-platform" | "self-hosted-paas";
export type ComparisonTone = "included" | "different" | "operator" | "limited";

export interface ComparisonSource {
	label: string;
	url: string;
}

export interface ComparisonCell {
	value: string;
	tone: ComparisonTone;
}

export interface ComparisonRow {
	capability: string;
	nearzero: ComparisonCell;
	competitor: ComparisonCell;
	implication: string;
}

export interface ComparisonPage {
	slug: "vercel" | "coolify" | "dokploy" | "netlify";
	competitor: string;
	category: ComparisonCategory;
	categoryLabel: string;
	title: string;
	description: string;
	summary: string;
	quickAnswer: string;
	chooseNearzero: string[];
	chooseCompetitor: string[];
	rows: ComparisonRow[];
	implications: Array<{ title: string; copy: string }>;
	nearzeroLimitations: string[];
	competitorLimitations: string[];
	methodology: string;
	sources: ComparisonSource[];
	faqs: Array<{ question: string; answer: string }>;
}

export const comparisons: ComparisonPage[] = [
	{
		slug: "vercel",
		competitor: "Vercel",
		category: "managed-platform",
		categoryLabel: "Managed platform comparison",
		title: "Nearzero vs Vercel",
		description:
			"Compare Nearzero and Vercel for Git deploys, OCI containers, previews, domains, infrastructure ownership, and day-two operations.",
		summary:
			"Vercel manages its deployment runtime and infrastructure and delivers a polished framework and preview workflow. Nearzero is for teams that want the deployment control plane, workloads, domains, and operational authority on infrastructure they choose.",
		quickAnswer:
			"Choose Vercel when a managed global application platform and first-class preview workflow matter more than server control. Choose Nearzero when workloads must run on your own Linux servers, Docker and Compose are part of the operating model, or you need direct control of placement, routing, and operations.",
		chooseNearzero: [
			"You need applications, databases, and Compose stacks on Linux servers you control.",
			"You need to place workloads deliberately across local and remote servers.",
			"You want an optional delegated authoritative application zone and Traefik routes connected to the selected server.",
			"You want an infrastructure Agent whose mutations require the requesting user's RBAC, administrator-controlled permission for that action, and a separate production gate when applicable.",
		],
		chooseCompetitor: [
			"You want Vercel to own the runtime, scaling, edge delivery, and deployment infrastructure.",
			"Your workflow depends on automatic preview deployments for every branch or pull request.",
			"You want deep framework integration or Vercel Agent's plan-dependent code review and production investigation workflows.",
			"You prefer platform observability and generated deployment URLs over managing hosts and reverse proxies.",
		],
		rows: [
			{
				capability: "Operating model",
				nearzero: {
					value: "Self-hosted control plane and workloads",
					tone: "operator",
				},
				competitor: {
					value: "Vercel-managed cloud platform",
					tone: "different",
				},
				implication:
					"The core decision is infrastructure ownership, not whether both products can deploy from Git.",
			},
			{
				capability: "Git delivery",
				nearzero: {
					value: "Git providers, builds, and deployments",
					tone: "included",
				},
				competitor: {
					value: "Automatic production and preview deployments",
					tone: "included",
				},
				implication:
					"Vercel has the stronger managed preview workflow; Nearzero keeps the resulting runtime on your servers.",
			},
			{
				capability: "Docker workload model",
				nearzero: {
					value: "Applications, images, Compose, and Swarm",
					tone: "included",
				},
				competitor: {
					value: "OCI images run as Vercel Functions",
					tone: "different",
				},
				implication:
					"Vercel's current container support is real, but it is a managed Functions model rather than general Docker-host administration.",
			},
			{
				capability: "Server placement",
				nearzero: {
					value: "Choose local or connected remote hosts",
					tone: "included",
				},
				competitor: {
					value: "Infrastructure placement is platform-managed",
					tone: "different",
				},
				implication:
					"Nearzero exposes host choice and responsibility; Vercel abstracts both.",
			},
			{
				capability: "Domains and TLS",
				nearzero: {
					value: "CoreDNS option plus Traefik and Let's Encrypt",
					tone: "included",
				},
				competitor: {
					value: "Vercel DNS or external DNS plus automatic SSL",
					tone: "included",
				},
				implication:
					"Both can automate HTTPS. Nearzero associates routing with your selected server; Vercel terminates traffic on its platform.",
			},
			{
				capability: "Agentic operations",
				nearzero: {
					value: "Agent for customer-operated infrastructure",
					tone: "included",
				},
				competitor: {
					value: "Vercel Agent for code and managed-runtime context",
					tone: "included",
				},
				implication:
					"Both are agentic. Nearzero acts through policy-bounded tools on infrastructure you operate; Vercel Agent reviews code and investigates workloads inside Vercel's managed platform.",
			},
			{
				capability: "Observability",
				nearzero: {
					value: "Host metrics, deployments, logs, and notifications",
					tone: "included",
				},
				competitor: {
					value: "Managed runtime logs and observability",
					tone: "included",
				},
				implication:
					"Nearzero observes owned hosts and containers; Vercel observes workloads inside its managed runtime and applies plan-specific retention.",
			},
			{
				capability: "Infrastructure maintenance",
				nearzero: { value: "Your responsibility", tone: "operator" },
				competitor: { value: "Handled by Vercel", tone: "included" },
				implication:
					"Nearzero gives control with an operations burden. Vercel exchanges some control for a managed service.",
			},
		],
		implications: [
			{
				title: "The runtime boundary changes",
				copy: "A Vercel deployment becomes part of Vercel's managed runtime. A Nearzero deployment remains a Docker workload on a host your team selects, patches, backs up, and pays for directly.",
			},
			{
				title: "Container support is not the same product model",
				copy: "Vercel added OCI-compatible container images through Vercel Functions. That is different from administering Compose stacks, databases, networks, volumes, and arbitrary long-running services on your own Docker hosts.",
			},
			{
				title: "Preview convenience versus infrastructure continuity",
				copy: "Vercel automatically creates preview deployments and URLs around Git. Nearzero emphasizes one control plane across production infrastructure, remote servers, domains, and day-two operations.",
			},
			{
				title: "Both products are agentic in different boundaries",
				copy: "Vercel Agent uses Vercel's code, deployment, and runtime context for review and investigation. Nearzero's Agent operates customer-managed server and service context, with requesting-user RBAC, administrator-controlled actions, and a separate production gate.",
			},
		],
		nearzeroLimitations: [
			"Nearzero does not provide Vercel's managed global edge, automatic platform scaling, or managed infrastructure SLA.",
			"Your team owns server patching, capacity, firewall policy, backups, and incident response.",
			"Nearzero's Community workflow does not promise equivalent framework-specific previews or the same integration depth as Vercel.",
		],
		competitorLimitations: [
			"Vercel does not expose the same customer-managed Linux server and Docker fleet model.",
			"OCI images run within the Vercel Functions model rather than as unrestricted services on a host you administer.",
			"Build, deployment, log-retention, route, and runtime limits vary by plan and product limit.",
			"Vercel Agent capabilities, availability, and usage costs are plan-dependent and should be checked before purchase.",
		],
		methodology:
			"This comparison uses Vercel's documented deployment, Git, OCI container, domain, SSL, observability, Agent, and limits behavior. It compares operating models rather than benchmark performance or attempting to score unlike runtimes as interchangeable.",
		sources: [
			{
				label: "Vercel: Deploying Git repositories",
				url: "https://vercel.com/docs/git",
			},
			{
				label: "Vercel: Deployment overview",
				url: "https://vercel.com/docs/deployments/overview",
			},
			{
				label: "Vercel: OCI container deployments",
				url: "https://vercel.com/kb/guide/does-vercel-support-docker-deployments",
			},
			{
				label: "Vercel: Custom domains",
				url: "https://vercel.com/docs/domains/set-up-custom-domain",
			},
			{
				label: "Vercel: SSL certificates",
				url: "https://vercel.com/docs/domains/working-with-ssl",
			},
			{
				label: "Vercel: Observability",
				url: "https://vercel.com/products/observability",
			},
			{
				label: "Vercel: Agent",
				url: "https://vercel.com/docs/agent",
			},
			{
				label: "Vercel: Platform limits",
				url: "https://vercel.com/docs/limits",
			},
		],
		faqs: [
			{
				question: "Is Nearzero a drop-in replacement for Vercel?",
				answer:
					"No. Both can turn source code into a public application, but the operating models differ. Vercel provides a managed runtime and edge platform; Nearzero manages workloads on infrastructure you operate.",
			},
			{
				question: "Does Vercel support Docker now?",
				answer:
					"Yes. Vercel documents OCI-compatible container images deployed as Vercel Functions. That should not be described as equivalent to running arbitrary Docker Compose stacks or managing a customer-owned Docker server.",
			},
			{
				question: "Which is better for preview deployments?",
				answer:
					"Vercel is the clearer choice when automatic branch and pull-request previews are central. Nearzero is better evaluated around self-hosted production infrastructure and ongoing operations.",
			},
			{
				question: "Which gives more control over where workloads run?",
				answer:
					"Nearzero lets an operator choose connected local or remote servers. Vercel intentionally abstracts the underlying server fleet through its managed platform.",
			},
			{
				question: "Can both use custom domains and HTTPS?",
				answer:
					"Yes. Both document custom-domain and automatic certificate workflows. Their traffic targets differ: Vercel routes to its infrastructure, while Nearzero routes to the selected server managed through Nearzero.",
			},
			{
				question: "Does Vercel have its own infrastructure Agent?",
				answer:
					"Yes. Vercel Agent provides plan-dependent code review, production investigation, and related workflows using Vercel's managed code, deployment, and runtime context. Nearzero's Agent is differentiated by operating customer-managed server and service context through organization-scoped action policies.",
			},
		],
	},
	{
		slug: "coolify",
		competitor: "Coolify",
		category: "self-hosted-paas",
		categoryLabel: "Self-hosted PaaS comparison",
		title: "Nearzero vs Coolify",
		description:
			"Compare Nearzero and Coolify for self-hosting, Git, Compose, databases, remote servers, domains, TLS, and operations.",
		summary:
			"Coolify is an established Apache-2.0 self-hosted PaaS with broad Git, service, preview, and server-management workflows. Nearzero is a project-oriented control plane for applications, data, Compose, remote servers, monitoring, and optional authoritative application DNS; its Agent is an additional policy-bounded operating interface.",
		quickAnswer:
			"Choose Coolify for its established self-hosted PaaS ecosystem, broad one-click service catalog, and Git preview workflow. Choose Nearzero when its project, server, domain, and operations model—or optional authoritative CoreDNS zone—better fits your infrastructure.",
		chooseNearzero: [
			"You want applications, databases, and Compose stacks organized around projects and environments.",
			"You want local and remote server placement, metrics, logs, and domains in one operational view.",
			"You want Nearzero to serve a delegated authoritative application zone and direct each service record to its selected server.",
			"You want Agent mutations checked against requesting-user RBAC and administrator-controlled per-action policy, with a separate production gate that starts disabled.",
		],
		chooseCompetitor: [
			"You value an established community, extensive one-click services, and a long-running self-hosted PaaS project.",
			"Pull-request previews and broad Git-provider workflows are central to the team experience.",
			"You want an Apache-2.0 codebase whose docs explicitly state that the open-source edition has no feature restrictions.",
			"You are comfortable managing external DNS records and the documented root-capable SSH model.",
		],
		rows: [
			{
				capability: "Self-hosting",
				nearzero: {
					value: "Community control plane on your infrastructure",
					tone: "operator",
				},
				competitor: {
					value: "Apache-2.0 self-hosted platform",
					tone: "included",
				},
				implication:
					"Both put server cost and maintenance with the operator; review licensing and maturity separately.",
			},
			{
				capability: "Git delivery",
				nearzero: {
					value: "Repository builds and deployments",
					tone: "included",
				},
				competitor: {
					value: "Broad providers, webhooks, and PR previews",
					tone: "included",
				},
				implication:
					"Coolify documents a broader preview and arbitrary-provider workflow today.",
			},
			{
				capability: "Docker and Compose",
				nearzero: {
					value: "Applications, Compose, databases, and Swarm",
					tone: "included",
				},
				competitor: {
					value: "Applications, Compose, services, and experimental Swarm",
					tone: "included",
				},
				implication:
					"Neither should be presented as uniquely supporting Docker Compose or common databases.",
			},
			{
				capability: "Remote servers",
				nearzero: {
					value: "Local and remote workload servers",
					tone: "included",
				},
				competitor: {
					value: "Local and remote Docker servers over SSH",
					tone: "included",
				},
				implication:
					"Both route traffic directly to the server hosting the workload rather than through the UI host.",
			},
			{
				capability: "DNS and domains",
				nearzero: {
					value: "Optional authoritative CoreDNS plus external domains",
					tone: "included",
				},
				competitor: {
					value: "External DNS or wildcard records plus proxy domains",
					tone: "different",
				},
				implication:
					"Coolify manages routing after DNS resolves; Nearzero can also operate a delegated application zone.",
			},
			{
				capability: "TLS and ingress",
				nearzero: { value: "Traefik with Let's Encrypt", tone: "included" },
				competitor: {
					value: "Traefik or Caddy with automatic Let's Encrypt",
					tone: "included",
				},
				implication:
					"Both automate HTTPS when DNS and inbound networking are correct.",
			},
			{
				capability: "AI infrastructure access",
				nearzero: {
					value: "Agent gated by RBAC, per-action policy, and production gate",
					tone: "included",
				},
				competitor: {
					value: "Built-in MCP endpoint for external AI clients",
					tone: "included",
				},
				implication:
					"Both expose infrastructure context to agents. Nearzero embeds the Agent and its server-side policy boundary; Coolify exposes team-scoped MCP tools whose abilities depend on the deployed version and token permission.",
			},
			{
				capability: "Monitoring and operations",
				nearzero: {
					value: "Host metrics, logs, backups, and notifications",
					tone: "included",
				},
				competitor: {
					value: "Health checks, monitoring, cleanup, backups, and alerts",
					tone: "included",
				},
				implication:
					"Both cover day-two operations; compare exact retention, recovery, and alert behavior for your workload.",
			},
			{
				capability: "Horizontal operation",
				nearzero: {
					value: "Remote placement and Docker Swarm",
					tone: "operator",
				},
				competitor: {
					value: "Multi-server and Swarm marked experimental",
					tone: "limited",
				},
				implication:
					"Neither product removes the need to design registries, load balancers, storage, and failure recovery.",
			},
		],
		implications: [
			{
				title: "The meaningful difference is the operating model",
				copy: "Both platforms cover Git-to-server deployment. Nearzero keeps project state, workload placement, managed records, monitoring, and day-two operations connected; its embedded Agent is available within requesting-user RBAC, administrator-controlled actions, and a separate production gate.",
			},
			{
				title: "DNS ownership is materially different",
				copy: "Coolify's documented model asks operators to point external A or wildcard records at each workload server. Nearzero can serve a delegated authoritative application zone and create records based on the selected server.",
			},
			{
				title: "Both still require infrastructure engineering",
				copy: "Root-capable SSH, Docker networking, firewalls, external registries, persistent storage, backups, and failure recovery remain operator concerns. A self-hosted PaaS reduces toil; it does not remove the underlying systems.",
			},
		],
		nearzeroLimitations: [
			"Nearzero has a younger public ecosystem and does not claim Coolify's catalog depth or community scale.",
			"Its default authoritative DNS service is a single failure domain unless the operator provides an independent secondary authority.",
			"The Community edition still requires secure server maintenance, capacity planning, backups, and recovery testing.",
		],
		competitorLimitations: [
			"Coolify says non-root users are not fully supported, and its automation SSH key cannot use a passphrase or 2FA.",
			"The documented multi-server replication and Docker Swarm paths are experimental, require a registry, and leave load balancing or shared storage to the operator.",
			"Coolify's docs say server security and operating-system updates remain the user's responsibility.",
			"Coolify's MCP page describes a read-only posture while its current tool catalog also lists deploy-token lifecycle tools; verify the installed version and use a least-privileged token.",
		],
		methodology:
			"This comparison uses Coolify's official v4 documentation, built-in MCP documentation, and repository. It treats documented parity as parity, labels experimental scaling paths, and does not infer the absence of features from a missing marketing bullet alone.",
		sources: [
			{
				label: "Coolify: Project and Apache-2.0 source",
				url: "https://github.com/coollabsio/coolify",
			},
			{
				label: "Coolify: Product introduction",
				url: "https://coolify.io/docs/get-started/introduction",
			},
			{
				label: "Coolify: Server and multi-server architecture",
				url: "https://coolify.io/docs/knowledge-base/server/introduction",
			},
			{
				label: "Coolify: Git providers and CI/CD",
				url: "https://coolify.io/docs/applications/ci-cd",
			},
			{
				label: "Coolify: Docker Compose",
				url: "https://coolify.io/docs/knowledge-base/docker/compose",
			},
			{
				label: "Coolify: Domains and automatic TLS",
				url: "https://coolify.io/docs/knowledge-base/domains",
			},
			{
				label: "Coolify: Multiple-server deployments",
				url: "https://coolify.io/docs/knowledge-base/server/multiple-servers",
			},
			{
				label: "Coolify: Docker Swarm",
				url: "https://coolify.io/docs/knowledge-base/docker/swarm",
			},
			{
				label: "Coolify: Monitoring",
				url: "https://coolify.io/docs/knowledge-base/monitoring",
			},
			{
				label: "Coolify: Built-in MCP server",
				url: "https://coolify.io/docs/integrations/mcp",
			},
			{
				label: "Nearzero: Community license",
				url: "https://github.com/Nearzero-systems/nearzero/blob/main/LICENSE.MD",
			},
		],
		faqs: [
			{
				question: "Are Nearzero and Coolify both self-hosted PaaS products?",
				answer:
					"Yes. Both manage applications and services on infrastructure the operator controls. The meaningful comparison is workflow, boundaries, DNS model, maturity, and operations—not whether only one can self-host.",
			},
			{
				question: "Does Coolify support remote and multiple servers?",
				answer:
					"Yes. Coolify can connect remote Docker servers over SSH, and each server runs its own proxy. Its same-application multi-server and Swarm documentation marks those paths experimental and describes registry and load-balancer requirements.",
			},
			{
				question: "Does Coolify provide automatic HTTPS?",
				answer:
					"Yes. Coolify documents automatic Let's Encrypt certificates through Traefik or Caddy. DNS must resolve to the correct workload server, and a failed issuance can leave a self-signed fallback certificate.",
			},
			{
				question: "What is Nearzero's clearest difference?",
				answer:
					"Nearzero connects projects, workload placement, managed records, monitoring, and day-two operations in one control plane. It can also serve a delegated authoritative application zone, while its optional Agent follows requesting-user RBAC, administrator-controlled per-action policy, and a separate production gate.",
			},
			{
				question: "How do the documented licenses compare?",
				answer:
					"Coolify's v4 repository and Nearzero Community code outside any separately licensed proprietary directory are documented under Apache 2.0. Review each repository's current license and any separately licensed directories before redistribution.",
			},
		],
	},
	{
		slug: "dokploy",
		competitor: "Dokploy",
		category: "self-hosted-paas",
		categoryLabel: "Self-hosted PaaS comparison",
		title: "Nearzero vs Dokploy",
		description:
			"Compare Nearzero and Dokploy for self-hosting, Git, Compose, databases, remote and build servers, domains, monitoring, and governance.",
		summary:
			"Dokploy provides a broad self-hosted Docker PaaS with remote deployment servers, application build servers, Compose, Swarm, domains, backups, AI-assisted Compose generation, and optional enterprise governance. Nearzero connects applications, data, Compose, workload placement, monitoring, and optional authoritative DNS in one control plane, with a policy-bounded Agent available for operations.",
		quickAnswer:
			"Choose Dokploy when its established deployment UI, dedicated application build servers, AI-assisted Compose generation, template ecosystem, or commercial enterprise controls fit the requirement. Choose Nearzero when integrated workload placement, managed service records, monitoring, and day-two operations better fit the requirement.",
		chooseNearzero: [
			"You want applications, databases, and Compose stacks in one project-oriented control plane.",
			"You want managed service records to target the local or remote server selected for each workload.",
			"You want deployment state, logs, host metrics, domains, and routing to stay attached to the workload.",
			"You want Agent mutations checked against requesting-user RBAC and administrator-controlled per-action policy, with production mutations separately disabled by default.",
		],
		chooseCompetitor: [
			"You need a documented separate build-server workflow for applications.",
			"You want Dokploy's template catalog, AI-assisted Compose generation, deployment UI, registry rollbacks, schedules, or broader notification integrations.",
			"You need commercial enterprise options such as SSO, custom roles, audit logs, application authentication, or whitelabeling.",
			"You accept the root-and-Bash remote setup model and understand which monitoring features differ between self-hosted and Cloud editions.",
		],
		rows: [
			{
				capability: "Self-hosting and source",
				nearzero: {
					value: "Self-hosted Community repository",
					tone: "operator",
				},
				competitor: {
					value: "Apache-2.0 core plus proprietary enterprise code",
					tone: "different",
				},
				implication:
					"Dokploy's current repository is mixed-license; do not describe it as wholly proprietary or wholly Apache-2.0.",
			},
			{
				capability: "Git delivery",
				nearzero: {
					value: "Repository builds and deployments",
					tone: "included",
				},
				competitor: {
					value: "GitHub, GitLab, Bitbucket, Gitea, generic Git",
					tone: "included",
				},
				implication:
					"Both support Git-driven deployment; compare provider setup and preview needs rather than claiming exclusivity.",
			},
			{
				capability: "Docker and Compose",
				nearzero: {
					value: "Applications, databases, Compose, and Swarm",
					tone: "included",
				},
				competitor: {
					value: "Applications, databases, Compose, and Stack",
					tone: "included",
				},
				implication:
					"Dokploy Stack deployments require prebuilt images because Docker Stack does not support build.",
			},
			{
				capability: "Remote and build servers",
				nearzero: { value: "Remote workload servers", tone: "included" },
				competitor: {
					value: "Remote deployment servers and app-only build servers",
					tone: "included",
				},
				implication:
					"Dokploy documents stronger build/deploy separation; its build-server feature does not support Compose.",
			},
			{
				capability: "DNS and domains",
				nearzero: {
					value: "Optional authoritative CoreDNS plus external domains",
					tone: "included",
				},
				competitor: {
					value: "External DNS plus Traefik domain management",
					tone: "different",
				},
				implication:
					"Dokploy manages domain routing but its documented flow still asks the operator to create provider DNS records.",
			},
			{
				capability: "TLS and ingress",
				nearzero: { value: "Traefik and Let's Encrypt", tone: "included" },
				competitor: {
					value: "Traefik, Let's Encrypt, and custom certificates",
					tone: "included",
				},
				implication:
					"Both support HTTPS; Dokploy's generated traefik.me names are HTTP-only until a separate certificate is configured.",
			},
			{
				capability: "AI assistance",
				nearzero: {
					value: "Agent gated by RBAC, per-action policy, and production gate",
					tone: "included",
				},
				competitor: {
					value: "AI-generated Docker Compose templates",
					tone: "included",
				},
				implication:
					"Both use AI, but for different jobs: Nearzero inspects and operates platform context under server-enforced policy; Dokploy generates a Compose starting point for the operator to review before deployment.",
			},
			{
				capability: "Monitoring",
				nearzero: {
					value: "Host and service metrics in Community",
					tone: "included",
				},
				competitor: {
					value: "Basic app views; advanced monitoring differs by edition",
					tone: "limited",
				},
				implication:
					"Dokploy's docs say remote-server monitoring is unsupported and its separate monitoring service is Cloud-only.",
			},
			{
				capability: "Governance",
				nearzero: {
					value: "User RBAC, admin-controlled Agent actions, production gate",
					tone: "included",
				},
				competitor: {
					value: "Built-in roles; enterprise SSO, custom RBAC, and audit logs",
					tone: "different",
				},
				implication:
					"Dokploy offers a paid governance path; Nearzero Community's Agent mutations additionally require user RBAC, administrator-controlled per-action policy, and, for production, a separate gate that defaults off.",
			},
		],
		implications: [
			{
				title: "Remote deployment and cluster scaling are separate decisions",
				copy: "Dokploy can place different applications on remote deployment servers and can also form Docker Swarm clusters. A cluster additionally requires compatible node architecture, a registry, routing, storage, and cleanup planning.",
			},
			{
				title: "The edition changes operational expectations",
				copy: "Dokploy's core deployment engine is available in its free self-hosted edition, while SSO, custom roles, audit logs, application authentication, whitelabeling, and unlimited concurrent builds are enterprise capabilities.",
			},
			{
				title: "Compose remains explicit infrastructure",
				copy: "Dokploy writes UI environment values to a .env file, but containers receive them only when the Compose file references them. Compose domain changes also require redeployment because routing is injected through Docker labels.",
			},
			{
				title: "AI assistance targets different work",
				copy: "Dokploy's BYOK AI Assistant generates editable Docker Compose templates from natural language. Nearzero's Agent works with live project, deployment, server, log, and domain context through server-enforced action policy.",
			},
		],
		nearzeroLimitations: [
			"Nearzero does not currently claim Dokploy's dedicated application build-server workflow or enterprise governance catalog.",
			"Nearzero's Community deployment remains operator-managed and does not include a managed control-plane SLA.",
			"Authoritative DNS requires port 53, correct delegation, and independent secondary DNS planning for critical production zones.",
		],
		competitorLimitations: [
			"Remote deployment currently requires root access and a Bash-default server; non-root deployment is unsupported.",
			"Remote-server monitoring is documented as unsupported, while the separate monitoring service is Cloud-only and server-threshold alerts are not per service.",
			"Compose domain changes require redeployment, build servers do not support Compose, and Stack builds require registry images.",
			"AI Compose generation requires an external provider and API key, and Dokploy tells operators to review and edit generated configuration before deployment.",
			"Enterprise directories use a production-restricted source-available license, and enterprise features require a valid commercial license.",
		],
		methodology:
			"This comparison uses Dokploy's current official docs, AI Assistant documentation, repository licenses, and edition matrix. Where the README and newer edition documentation differ in breadth, the comparison uses the more specific current edition and feature pages.",
		sources: [
			{
				label: "Dokploy: Repository and feature overview",
				url: "https://github.com/Dokploy/dokploy",
			},
			{
				label: "Dokploy: Core and proprietary licensing",
				url: "https://github.com/Dokploy/dokploy/blob/canary/LICENSE.MD",
			},
			{
				label: "Dokploy: Proprietary source-available license",
				url: "https://github.com/Dokploy/dokploy/blob/canary/LICENSE_PROPRIETARY.md",
			},
			{
				label: "Dokploy: Cloud vs self-hosted editions",
				url: "https://docs.dokploy.com/docs/core/differences",
			},
			{
				label: "Dokploy: Git and deployment providers",
				url: "https://docs.dokploy.com/docs/core/providers",
			},
			{
				label: "Dokploy: Docker Compose and Stack",
				url: "https://docs.dokploy.com/docs/core/docker-compose",
			},
			{
				label: "Dokploy: Remote and build servers",
				url: "https://docs.dokploy.com/docs/core/remote-servers",
			},
			{
				label: "Dokploy: Remote deployment requirements",
				url: "https://docs.dokploy.com/docs/core/remote-servers/deployments",
			},
			{
				label: "Dokploy: Domains",
				url: "https://docs.dokploy.com/docs/core/domains",
			},
			{
				label: "Dokploy: Monitoring",
				url: "https://docs.dokploy.com/docs/core/monitoring",
			},
			{
				label: "Dokploy: AI Assistant",
				url: "https://docs.dokploy.com/docs/core/ai",
			},
			{
				label: "Dokploy: Enterprise capabilities",
				url: "https://docs.dokploy.com/docs/core/enterprise",
			},
		],
		faqs: [
			{
				question: "Is Dokploy open source?",
				answer:
					"Its current repository licenses code outside /proprietary under Apache-2.0. Code inside /proprietary uses the Dokploy Source Available License and requires a commercial agreement for production use. “Open-core” is a fair shorthand; “entirely proprietary” is not.",
			},
			{
				question: "Does Dokploy support multiple remote servers?",
				answer:
					"Yes. It documents remote deployment servers and separate build servers, plus Docker Swarm clustering. Build servers are currently limited to Applications and do not support Compose deployments.",
			},
			{
				question: "Does Dokploy support monitoring?",
				answer:
					"Yes, but the exact behavior depends on context. Application pages show resource graphs, remote-server monitoring is documented as unsupported, and the separate retained monitoring system is described as Cloud-only.",
			},
			{
				question: "Can both platforms manage custom domains and HTTPS?",
				answer:
					"Yes. Both use Traefik-oriented routing and support Let's Encrypt. Nearzero can additionally serve a delegated authoritative application zone; Dokploy's documented flow expects external DNS records.",
			},
			{
				question: "Why choose Nearzero instead of Dokploy?",
				answer:
					"Choose Nearzero when integrated application, data, server, domain, monitoring, and optional authoritative DNS workflows fit your operating model. Its Agent adds a policy-bounded operational interface. Choose Dokploy when AI-assisted Compose generation, its broader deployment surface, build-server option, or enterprise controls matter more.",
			},
			{
				question: "Does Dokploy include AI assistance?",
				answer:
					"Yes. Dokploy's BYOK AI Assistant generates Docker Compose templates from natural language for the operator to review and edit. Nearzero's Agent instead focuses on inspecting and operating live platform resources through scoped tools and server-enforced policy.",
			},
		],
	},
	{
		slug: "netlify",
		competitor: "Netlify",
		category: "managed-platform",
		categoryLabel: "Managed platform comparison",
		title: "Nearzero vs Netlify",
		description:
			"Compare Nearzero and Netlify for Git deploys, previews, edge delivery, domains, Docker workloads, server operations, and infrastructure ownership.",
		summary:
			"Netlify is a managed web platform built around Git or agent-driven creation, atomic deploys, previews, Functions, and global edge delivery. Nearzero is a self-hosted platform for containers, databases, Compose, remote servers, domains, and host operations.",
		quickAnswer:
			"Choose Netlify for managed global web delivery, atomic deploys, previews, Functions, and a platform that removes server administration. Choose Nearzero when you need server ownership, Compose, persistent data, server-aware routing, and direct host operations.",
		chooseNearzero: [
			"You need applications, databases, or Compose stacks on infrastructure you own.",
			"You need to connect and select remote Linux workload servers rather than consume an abstract managed runtime.",
			"You want an infrastructure Agent constrained by the requesting user's RBAC, administrator-controlled per-action policy, and a separate production gate.",
			"You want optional authoritative application DNS and Traefik HTTPS tied to the server that runs each service.",
		],
		chooseCompetitor: [
			"You are shipping modern web applications and want global edge delivery without managing origin servers.",
			"Automatic deploy previews, atomic releases, instant rollbacks, Functions, and CDN behavior are core requirements.",
			"You want Agent Runners to build or update application code inside a managed web workflow.",
			"You prefer Netlify-managed DNS, HTTPS, DDoS protection, and plan-based observability.",
		],
		rows: [
			{
				capability: "Operating model",
				nearzero: {
					value: "Self-hosted infrastructure control plane",
					tone: "operator",
				},
				competitor: { value: "Managed global web platform", tone: "different" },
				implication:
					"Nearzero exposes hosts and containers; Netlify intentionally removes origin-server management.",
			},
			{
				capability: "Git and previews",
				nearzero: { value: "Git builds and deployments", tone: "included" },
				competitor: {
					value: "Git, branch deploys, and automatic Deploy Previews",
					tone: "included",
				},
				implication:
					"Netlify's atomic preview workflow is a core strength and should not be minimized.",
			},
			{
				capability: "Runtime model",
				nearzero: {
					value: "Long-running containers, databases, Compose",
					tone: "included",
				},
				competitor: {
					value: "Static edge delivery, Functions, and Edge Functions",
					tone: "different",
				},
				implication:
					"These runtimes overlap for web applications but are not interchangeable for arbitrary Docker services.",
			},
			{
				capability: "Server fleet control",
				nearzero: {
					value: "Select local and remote Linux servers",
					tone: "included",
				},
				competitor: {
					value: "No origin infrastructure to manage",
					tone: "different",
				},
				implication:
					"Nearzero supports workload-placement and chosen-storage decisions; Netlify offers managed infrastructure instead.",
			},
			{
				capability: "Domains and TLS",
				nearzero: {
					value: "CoreDNS option plus Traefik and Let's Encrypt",
					tone: "included",
				},
				competitor: {
					value: "Netlify DNS or external DNS plus managed HTTPS",
					tone: "included",
				},
				implication:
					"Both provide custom-domain workflows; Netlify maps to its edge, Nearzero maps to selected workload servers.",
			},
			{
				capability: "AI and agents",
				nearzero: {
					value: "Infrastructure Agent gated by RBAC and action policy",
					tone: "included",
				},
				competitor: {
					value: "Agent Runners create and update application code",
					tone: "different",
				},
				implication:
					"Both are agentic, but the jobs differ: policy-bounded infrastructure operations versus building and iterating software.",
			},
			{
				capability: "Observability",
				nearzero: {
					value: "Owned-host metrics, logs, and deployments",
					tone: "included",
				},
				competitor: {
					value: "Request, runtime, function, and edge observability",
					tone: "included",
				},
				implication:
					"Netlify's retention varies by plan and native Observability does not provide alerting or programmatic access.",
			},
			{
				capability: "Infrastructure maintenance",
				nearzero: { value: "Operator-owned", tone: "operator" },
				competitor: { value: "Managed by Netlify", tone: "included" },
				implication:
					"The operational burden and the degree of control move together.",
			},
		],
		implications: [
			{
				title: "“Agentic” describes different work",
				copy: "Netlify Agent Runners build and update web projects using coding agents. Nearzero's Agent inspects and operates deployment infrastructure only when requesting-user RBAC and administrator-controlled per-action policy permit it; production mutations also require a separate gate. Neither product should be described as lacking agents.",
			},
			{
				title: "Global edge delivery versus owned origins",
				copy: "Netlify's value comes from atomic global deploys, caching, Functions, and no origin infrastructure to manage. Nearzero trades that abstraction for control over servers, persistent containers, databases, networking, and workload location.",
			},
			{
				title: "Self-hosted Git is not self-hosted Netlify",
				copy: "Netlify can connect to supported self-managed Git providers, subject to documented connectivity and repository limitations. The deployment platform and runtime remain Netlify-managed.",
			},
		],
		nearzeroLimitations: [
			"Nearzero does not provide Netlify's managed CDN, global edge network, atomic deploy system, or managed infrastructure SLA.",
			"The operator is responsible for host security, capacity, backups, routing availability, and incident response.",
			"Nearzero's Agent is not presented as a replacement for Netlify's code-creation Agent Runners.",
		],
		competitorLimitations: [
			"Netlify's documented runtime centers managed static delivery, Functions, and Edge Functions rather than arbitrary customer-managed Docker hosts and Compose stacks.",
			"Native Observability has plan-based retention and does not currently include alerting, long-term retention, custom dashboards, or programmatic access.",
			"Self-hosted Git connections have documented availability, public-URL, sensitive-variable-policy, and provider-specific limitations.",
		],
		methodology:
			"This comparison uses Netlify's current platform, deploy, domain, HTTPS, self-hosted Git, and observability documentation. It treats Agent Runners as a real but different agent use case and does not equate open-source Netlify tools with a self-hostable Netlify platform.",
		sources: [
			{
				label: "Netlify: Platform overview",
				url: "https://www.netlify.com/platform/",
			},
			{
				label: "Netlify: Build and deployment workflow",
				url: "https://www.netlify.com/platform/core/build/",
			},
			{
				label: "Netlify: Edge runtime and delivery",
				url: "https://www.netlify.com/platform/core/edge/",
			},
			{
				label: "Netlify: Creating deploys",
				url: "https://docs.netlify.com/deploy/create-deploys/",
			},
			{
				label: "Netlify: Domain fundamentals",
				url: "https://docs.netlify.com/manage/domains/domains-fundamentals/understand-domains/",
			},
			{
				label: "Netlify: HTTPS and certificates",
				url: "https://docs.netlify.com/manage/domains/secure-domains-with-https/https-ssl/",
			},
			{
				label: "Netlify: Observability",
				url: "https://docs.netlify.com/manage/monitoring/observability/overview/",
			},
			{
				label: "Netlify: Self-hosted Git",
				url: "https://docs.netlify.com/build/git-workflows/self-hosted-git/",
			},
			{
				label: "Netlify: Agent Runners",
				url: "https://docs.netlify.com/build/build-with-ai/agent-runners/overview/",
			},
		],
		faqs: [
			{
				question: "Is Nearzero a replacement for Netlify?",
				answer:
					"Only for teams whose real requirement is self-hosted container infrastructure. Netlify's managed edge, atomic deploys, previews, and Functions are a different product model and may be the better fit for web-first teams.",
			},
			{
				question: "Does Netlify have AI agents?",
				answer:
					"Yes. Netlify Agent Runners use coding agents to create and update applications. Nearzero's Agent targets scoped deployment and infrastructure operations, so the comparison should focus on the job each agent performs.",
			},
			{
				question: "Can Netlify connect to self-hosted Git?",
				answer:
					"Yes, for supported enterprise Git providers and subject to documented connectivity and repository requirements. This does not make the Netlify deployment runtime self-hosted.",
			},
			{
				question: "Which is better for Docker Compose and databases?",
				answer:
					"Nearzero is the direct fit when the workload is a Compose stack, persistent database, or arbitrary service on a Linux Docker host. Netlify's documented product model is managed web delivery plus Functions and edge capabilities.",
			},
			{
				question: "Can both manage domains and HTTPS?",
				answer:
					"Yes. Netlify can manage DNS or use external DNS and provides managed HTTPS. Nearzero can use external domains or serve a delegated application zone and routes the hostname through Traefik on the selected server.",
			},
		],
	},
];

export const comparisonBySlug = Object.fromEntries(
	comparisons.map((comparison) => [comparison.slug, comparison]),
) as Record<ComparisonPage["slug"], ComparisonPage>;

export const comparisonGroups = [
	{
		id: "managed-platforms",
		label: "Managed platforms",
		description:
			"Vercel and Netlify own the runtime and global delivery layer. Compare them with Nearzero when the decision is managed convenience versus infrastructure ownership.",
		question: "Do you want to operate servers, or consume a managed runtime?",
		comparisons: comparisons.filter(
			(comparison) => comparison.category === "managed-platform",
		),
	},
	{
		id: "self-hosted-paas",
		label: "Self-hosted PaaS",
		description:
			"Coolify and Dokploy already cover Git-to-server deployment, Docker, Compose, domains, TLS, and multi-server workflows. Compare deployment UX, DNS, governance, maturity, and operational constraints.",
		question: "Which self-hosted control plane matches your operating model?",
		comparisons: comparisons.filter(
			(comparison) => comparison.category === "self-hosted-paas",
		),
	},
] as const;
