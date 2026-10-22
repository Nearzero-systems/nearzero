export type ComparisonCategory = "managed-platform" | "self-hosted-paas";
export type ComparisonTone = "included" | "different" | "operator" | "limited";

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

export interface ComparisonWin {
	title: string;
	copy: string;
}

export interface ComparisonPage {
	slug: "vercel" | "coolify" | "netlify";
	competitor: string;
	category: ComparisonCategory;
	categoryLabel: string;
	title: string;
	description: string;
	summary: string;
	chooseNearzero: ComparisonWin[];
	rows: ComparisonRow[];
	implications: ComparisonWin[];
	faqs: Array<{ question: string; answer: string }>;
}

export const comparisons: ComparisonPage[] = [
	{
		slug: "vercel",
		competitor: "Vercel",
		category: "managed-platform",
		categoryLabel: "Managed platform",
		title: "Nearzero vs Vercel",
		description:
			"Vercel runs your app on their infrastructure. Nearzero deploys apps, databases, and Compose from Git onto Linux servers you own.",
		summary:
			"Vercel owns the runtime. You do not get a Docker host, a database on your VPS, or a say in which machine the work runs on. Nearzero is the control plane for that job — on servers you already pay for.",
		chooseNearzero: [
			{
				title: "Your VPS runs the app",
				copy: "Node, Python, Go, PHP, Ruby, Postgres, Redis, and Compose stay on Linux you control. Not inside a Functions runtime.",
			},
			{
				title: "You pick the server",
				copy: "Keep work on the control-plane host, or add another Linux box over SSH and place each service there.",
			},
			{
				title: "The hostname hits that server",
				copy: "Traefik and Let's Encrypt terminate HTTPS on the selected host. Optional CoreDNS writes the A record to that IP.",
			},
			{
				title: "The Agent sees your fleet",
				copy: "It can read deploys, logs, domains, and servers. Production writes stay off until an administrator turns that gate on.",
			},
		],
		rows: [
			{
				capability: "Where workloads run",
				nearzero: { value: "Linux servers you operate", tone: "operator" },
				competitor: {
					value: "Vercel-managed runtime and edge",
					tone: "different",
				},
				implication: "You keep the box. They keep the box.",
			},
			{
				capability: "Docker, Compose, databases",
				nearzero: {
					value: "Apps, images, Compose, Swarm, and data services",
					tone: "included",
				},
				competitor: {
					value: "OCI images run as Vercel Functions",
					tone: "limited",
				},
				implication:
					"A Functions container is not a Docker host you administer.",
			},
			{
				capability: "Server placement",
				nearzero: {
					value: "Local host or connected remote VPS",
					tone: "included",
				},
				competitor: { value: "No host for you to choose", tone: "different" },
				implication:
					"Nearzero places the service. Vercel abstracts the fleet away.",
			},
			{
				capability: "Domains and HTTPS",
				nearzero: {
					value: "Traefik on the selected server, optional CoreDNS",
					tone: "included",
				},
				competitor: {
					value: "Traffic ends on Vercel infrastructure",
					tone: "different",
				},
				implication:
					"Your hostname should reach the machine that runs the app.",
			},
			{
				capability: "Agent",
				nearzero: {
					value: "Operates your deploys, logs, and servers under policy",
					tone: "included",
				},
				competitor: {
					value: "Works inside Vercel’s code and managed runtime",
					tone: "different",
				},
				implication:
					"Nearzero’s Agent is for infrastructure you run, not their platform.",
			},
			{
				capability: "Who patches the server",
				nearzero: {
					value: "You. That is the point of owning it.",
					tone: "operator",
				},
				competitor: {
					value: "Vercel. You do not get the host.",
					tone: "different",
				},
				implication: "Control and operations stay together.",
			},
		],
		implications: [
			{
				title: "The runtime stays yours",
				copy: "A Nearzero deploy is a container on a host you select, patch, back up, and pay for. It does not become a slice of someone else’s edge.",
			},
			{
				title: "Data and Compose live with the app",
				copy: "Postgres, Redis, volumes, and Compose stacks sit on the same operating model as the application. You do not split “the site” onto Vercel and “the database” somewhere else.",
			},
			{
				title: "Remote servers are first-class",
				copy: "Add another Linux VPS over SSH. Point the domain at that host. Public traffic never has to bounce through the control plane.",
			},
			{
				title: "The Agent cannot go around you",
				copy: "Mutations need the requesting user’s RBAC, administrator-controlled per-action policy, and a separate production gate that starts disabled.",
			},
		],
		faqs: [
			{
				question: "Is Nearzero a drop-in Vercel replacement?",
				answer:
					"No. Nearzero is for teams that need a Docker host, databases, and Compose on machines they operate. It does not replace Vercel’s global CDN.",
			},
			{
				question: "Does Vercel give me a server I can SSH into?",
				answer:
					"No. You deploy into their runtime. Nearzero installs on a Linux VPS you already have, then deploys onto that host or others you add.",
			},
			{
				question: "Can I run Postgres and Compose with Nearzero?",
				answer:
					"Yes. Applications, Postgres, MySQL, MariaDB, MongoDB, Redis, libSQL, Docker Compose, and Swarm all run on the selected server.",
			},
			{
				question: "Does the Nearzero Agent change production on its own?",
				answer:
					"No. It can read project state and logs. Production writes stay off until an administrator turns that gate on, and even then the user’s role and action policy still apply.",
			},
			{
				question: "Do I still have to manage the VPS?",
				answer:
					"Yes. You patch, back up, and size the server. Nearzero builds, deploys, and routes. That is how you keep the infrastructure.",
			},
		],
	},
	{
		slug: "netlify",
		competitor: "Netlify",
		category: "managed-platform",
		categoryLabel: "Managed platform",
		title: "Nearzero vs Netlify",
		description:
			"Netlify hosts sites on their edge. It is not a Docker, database, or Compose control plane. Nearzero is, on the VPS you already pay for.",
		summary:
			"Netlify hosts sites on their edge. It is not a Docker, database, or Compose control plane. Nearzero is — on the VPS you already pay for.",
		chooseNearzero: [
			{
				title: "Long-running apps and data",
				copy: "Run containers, Postgres, Redis, and Compose on Linux you own. Netlify’s product is static delivery, Functions, and edge — not a Docker host.",
			},
			{
				title: "A server you can place work on",
				copy: "Install Nearzero on one VPS, add more over SSH, and choose where each service runs. Netlify does not give you that host.",
			},
			{
				title: "HTTPS on the machine that serves the app",
				copy: "Traefik and Let's Encrypt terminate TLS on the selected server. Optional CoreDNS points the hostname at that IP.",
			},
			{
				title: "An Agent for infrastructure, not code generation",
				copy: "Nearzero’s Agent reads deploys, logs, and servers. Netlify Agent Runners write application code. Different job.",
			},
		],
		rows: [
			{
				capability: "Where workloads run",
				nearzero: { value: "Your Linux servers", tone: "operator" },
				competitor: {
					value: "Netlify-managed edge and Functions",
					tone: "different",
				},
				implication: "You need a host. They remove the host.",
			},
			{
				capability: "Runtime",
				nearzero: { value: "Containers, databases, Compose", tone: "included" },
				competitor: {
					value: "Static sites, Functions, Edge Functions",
					tone: "limited",
				},
				implication:
					"Those runtimes are not a substitute for a Docker Compose stack.",
			},
			{
				capability: "Server fleet",
				nearzero: {
					value: "Select local and remote Linux hosts",
					tone: "included",
				},
				competitor: {
					value: "No origin server for you to operate",
					tone: "different",
				},
				implication: "Placement, volumes, and backups stay yours.",
			},
			{
				capability: "Domains and HTTPS",
				nearzero: { value: "Traefik on the selected server", tone: "included" },
				competitor: {
					value: "Hostname maps to Netlify’s edge",
					tone: "different",
				},
				implication: "Nearzero routes to the machine running the service.",
			},
			{
				capability: "Agent",
				nearzero: {
					value: "Policy-bounded infrastructure operations",
					tone: "included",
				},
				competitor: {
					value: "Agent Runners that write application code",
					tone: "different",
				},
				implication:
					"Nearzero does not pretend to be a coding agent. It operates the platform.",
			},
			{
				capability: "Self-hosted Git",
				nearzero: { value: "Build and run on your servers", tone: "included" },
				competitor: {
					value: "Connect Git; the runtime is still Netlify",
					tone: "limited",
				},
				implication: "Self-hosted Git is not a self-hosted Netlify.",
			},
		],
		implications: [
			{
				title: "The origin is yours",
				copy: "Apps, databases, and volumes live on a Linux host you select. You are not splitting a frontend onto Netlify and a database onto another vendor just to get a URL.",
			},
			{
				title: "Compose is a first-class workload",
				copy: "If the product is a Compose stack, a persistent database, or a long-running API, Nearzero is the control plane for that. Netlify is not.",
			},
			{
				title: "Traffic hits the selected server",
				copy: "Managed records and Traefik send the hostname to the IP that actually runs the service, including remote servers.",
			},
			{
				title: "You keep the keys",
				copy: "You still patch, back up, and size the VPS. That is how you keep the data, the network path, and the incident response.",
			},
		],
		faqs: [
			{
				question: "Is Nearzero a Netlify replacement?",
				answer:
					"Only if the real requirement is self-hosted containers, databases, and Compose. Nearzero does not replace a managed CDN.",
			},
			{
				question: "Can I run Docker Compose on Netlify?",
				answer:
					"No. Netlify’s documented runtime is managed web delivery plus Functions and edge. Nearzero runs Compose on a Linux Docker host you operate.",
			},
			{
				question: "Does connecting self-hosted Git make Netlify self-hosted?",
				answer:
					"No. The Git repo can live on your hardware. The deploy still runs on Netlify. Nearzero builds and runs on your VPS.",
			},
			{
				question:
					"What does the Nearzero Agent do that Netlify’s agents don’t?",
				answer:
					"It inspects and operates your deployments, logs, domains, and servers through scoped tools. Production mutations stay off until you enable them.",
			},
			{
				question: "Do I still operate the server?",
				answer:
					"Yes. Nearzero builds, deploys, and routes. You keep the VPS healthy. That is the product.",
			},
		],
	},
	{
		slug: "coolify",
		competitor: "Coolify",
		category: "self-hosted-paas",
		categoryLabel: "Self-hosted PaaS",
		title: "Nearzero vs Coolify",
		description:
			"Both run on your VPS. Nearzero connects placement, optional authoritative DNS, HTTPS, and a policy-bounded Agent in one control plane.",
		summary:
			"Coolify can ship Git to a server. Nearzero is the control plane that keeps placement, optional authoritative DNS, Traefik HTTPS, and a locked-down Agent attached to that server — without treating multi-server as an experiment.",
		chooseNearzero: [
			{
				title: "Placement and DNS stay connected",
				copy: "Pick the server for a service. Optional CoreDNS writes the A record to that IP. Coolify expects you to point external DNS at the host yourself.",
			},
			{
				title: "An Agent inside the product",
				copy: "Nearzero’s Agent uses scoped tools, user RBAC, per-action policy, and a production gate that starts off. Coolify exposes MCP to external clients.",
			},
			{
				title: "Remote servers for production work",
				copy: "Add Linux hosts over SSH and send public traffic straight to Traefik on that box. Coolify’s multi-server and Swarm paths are documented as experimental.",
			},
			{
				title: "One operating view",
				copy: "Projects, environments, deploys, logs, host metrics, domains, and policy live together. You are not stitching a PaaS to a separate DNS vendor and a separate agent.",
			},
		],
		rows: [
			{
				capability: "DNS",
				nearzero: {
					value: "Optional authoritative CoreDNS to the selected server",
					tone: "included",
				},
				competitor: {
					value: "You create external A or wildcard records",
					tone: "different",
				},
				implication:
					"Nearzero can own the application zone. Coolify stops at routing after DNS already points at the host.",
			},
			{
				capability: "Multi-server",
				nearzero: {
					value: "Remote placement over SSH, Swarm available",
					tone: "included",
				},
				competitor: {
					value: "Multi-server and Swarm marked experimental",
					tone: "limited",
				},
				implication:
					"If you need another VPS in production, that difference matters.",
			},
			{
				capability: "Agent access",
				nearzero: {
					value: "Embedded Agent, RBAC, action policy, production gate",
					tone: "included",
				},
				competitor: {
					value: "Built-in MCP for external AI clients",
					tone: "different",
				},
				implication:
					"Nearzero enforces mutations on the server. Coolify’s MCP ability depends on the token and installed version.",
			},
			{
				capability: "SSH model",
				nearzero: {
					value: "Dedicated setup identity, host-key verification",
					tone: "operator",
				},
				competitor: {
					value:
						"Non-root users not fully supported; key cannot use a passphrase or 2FA",
					tone: "limited",
				},
				implication:
					"Remote access is root-equivalent either way. Nearzero expects a dedicated identity and a verified fingerprint.",
			},
			{
				capability: "What you operate",
				nearzero: {
					value: "Control plane plus the hosts you place work on",
					tone: "operator",
				},
				competitor: {
					value: "Same VPS cost — DNS and extras stay outside",
					tone: "different",
				},
				implication:
					"Self-hosting is the starting point, not the differentiator.",
			},
		],
		implications: [
			{
				title: "The record follows the server",
				copy: "When a service moves to a remote host, Nearzero can write the A record to that IP. You are not maintaining a wildcard that hopes an external proxy knows the layout.",
			},
			{
				title: "The Agent is not a sidecar",
				copy: "It reads live project, deploy, log, domain, and server context through the same API as the console. Production writes stay disabled until you turn them on.",
			},
			{
				title: "Another VPS is a normal step",
				copy: "Connect it, verify the host key, open 80 and 443 for Traefik, keep Docker and management ports private. That path is the product, not an experiment.",
			},
		],
		faqs: [
			{
				question: "Can both Coolify and Nearzero self-host?",
				answer:
					"Yes. The question is the operating model: placement, DNS, and how an agent is allowed to change production.",
			},
			{
				question: "Does Coolify support Git and Docker?",
				answer:
					"Yes. Nearzero does too. Choose Nearzero when you want the selected server, the DNS record, HTTPS, and the Agent bound together.",
			},
			{
				question: "What is Nearzero’s clearest difference?",
				answer:
					"Optional authoritative DNS to the selected server, remote placement as a normal path, and an embedded Agent that cannot change production until you enable it.",
			},
			{
				question: "Does Nearzero replace Coolify’s one-click catalog?",
				answer:
					"No. Nearzero does not claim that catalog. It claims a connected control plane for apps, data, servers, domains, and policy.",
			},
			{
				question: "Do I still manage the VPS?",
				answer:
					"Yes. Both products leave patching and backups with you. Nearzero is honest about that because owning the host is the reason to install it.",
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
			"Vercel and Netlify own the runtime. You do not get the server. Nearzero is the control plane on the VPS you already pay for.",
		question: "Do you need a Docker host, or a managed edge?",
		comparisons: comparisons.filter(
			(comparison) => comparison.category === "managed-platform",
		),
	},
	{
		id: "self-hosted-paas",
		label: "Self-hosted PaaS",
		description:
			"Coolify already ships Git to a VPS. Nearzero keeps placement, optional DNS, HTTPS, metrics, and a locked-down Agent on that host.",
		question: "Which control plane stays attached to the server you selected?",
		comparisons: comparisons.filter(
			(comparison) => comparison.category === "self-hosted-paas",
		),
	},
] as const;
