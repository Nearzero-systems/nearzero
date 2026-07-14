import fs, { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { domainToASCII } from "node:url";
import { paths } from "@nearzero/server/constants";
import {
	isSafeTraefikRuleFragment,
	isValidDomainHost,
} from "@nearzero/server/db/validations/domain";
import type { Compose } from "@nearzero/server/services/compose";
import type { Domain } from "@nearzero/server/services/domain";
import { quote } from "shell-quote";
import { parse, stringify } from "yaml";
import type { PreparedShellCommand } from "../process/execAsync";
import { execAsyncRemote } from "../process/execAsync";
import { cloneBitbucketRepository } from "../providers/bitbucket";
import { cloneGitRepository } from "../providers/git";
import { cloneGiteaRepository } from "../providers/gitea";
import { cloneGithubRepository } from "../providers/github";
import { cloneGitlabRepository } from "../providers/gitlab";
import { getCreateComposeFileCommand } from "../providers/raw";
import { randomizeDeployableSpecificationFile } from "./collision";
import { randomizeSpecificationFile } from "./compose";
import type {
	ComposeSpecification,
	DefinitionsService,
	PropertiesNetworks,
} from "./types";
import { encodeBase64 } from "./utils";

const TRAEFIK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const TRAEFIK_MIDDLEWARE_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:@[A-Za-z0-9][A-Za-z0-9_.-]*)?$/;
const COMPOSE_SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const NEARZERO_ROUTING_MARKER = "nearzero.managed-domain-routing";

const assertTraefikName = (value: string, field: string, maxLength = 128) => {
	if (value.length > maxLength || !TRAEFIK_NAME_PATTERN.test(value)) {
		throw new Error(
			`${field} may only contain letters, numbers, periods, underscores, and hyphens`,
		);
	}
};

const assertSafePath = (value: string | null, field: string) => {
	if (value === null) return;
	if (
		value.length === 0 ||
		value.length > 2048 ||
		!value.startsWith("/") ||
		!isSafeTraefikRuleFragment(value)
	) {
		throw new Error(`${field} is not safe for a Traefik routing rule`);
	}
};

const validateDomainLabelInputs = (
	appName: string,
	domain: Domain,
	entrypoint: string,
) => {
	assertTraefikName(appName, "Application name", 63);
	assertTraefikName(entrypoint, "Traefik entrypoint");
	if (
		!Number.isSafeInteger(domain.uniqueConfigKey) ||
		domain.uniqueConfigKey < 1
	) {
		throw new Error("Domain configuration key must be a positive integer");
	}
	if (!isValidDomainHost(domain.host)) {
		throw new Error("Domain host is not safe for a Traefik routing rule");
	}
	assertSafePath(domain.path, "Domain path");
	assertSafePath(domain.internalPath, "Internal path");
	if (domain.customEntrypoint) {
		assertTraefikName(domain.customEntrypoint, "Custom Traefik entrypoint");
	}
	if (domain.customCertResolver) {
		assertTraefikName(domain.customCertResolver, "Custom certificate resolver");
	}
	if (domain.certificateType === "custom" && !domain.customCertResolver) {
		throw new Error(
			"A custom certificate resolver is required for custom certificates",
		);
	}
	if ((domain.middlewares?.length ?? 0) > 64) {
		throw new Error("A domain cannot use more than 64 Traefik middlewares");
	}
	for (const middleware of domain.middlewares ?? []) {
		if (
			middleware.length > 256 ||
			!TRAEFIK_MIDDLEWARE_PATTERN.test(middleware)
		) {
			throw new Error("Invalid Traefik middleware name");
		}
	}
	if (
		!Number.isInteger(domain.port) ||
		(domain.port ?? 0) < 1 ||
		(domain.port ?? 0) > 65535
	) {
		throw new Error(
			"Compose domain port must be an integer between 1 and 65535",
		);
	}
};

const labelKey = (label: string) => {
	const separator = label.indexOf("=");
	return separator === -1 ? label : label.slice(0, separator);
};

const isNearzeroDomainLabel = (key: string, appName: string) => {
	const routerPrefix = `traefik.http.routers.${appName}-`;
	const servicePrefix = `traefik.http.services.${appName}-`;
	const stripPrefix = `traefik.http.middlewares.stripprefix-${appName}-`;
	const addPrefix = `traefik.http.middlewares.addprefix-${appName}-`;

	if (key.startsWith(routerPrefix)) {
		return /^\d+-/.test(key.slice(routerPrefix.length));
	}
	if (key.startsWith(servicePrefix)) {
		return /^\d+-/.test(key.slice(servicePrefix.length));
	}
	if (key.startsWith(stripPrefix)) {
		return /^\d+\./.test(key.slice(stripPrefix.length));
	}
	if (key.startsWith(addPrefix)) {
		return /^\d+\./.test(key.slice(addPrefix.length));
	}
	return false;
};

const removeNearzeroDomainLabels = (
	labels: DefinitionsService["labels"] | undefined,
	appName: string,
) => {
	if (Array.isArray(labels)) {
		const retained = labels.filter(
			(label) => !isNearzeroDomainLabel(labelKey(label), appName),
		);
		labels.splice(0, labels.length, ...retained);
		return;
	}
	if (labels && typeof labels === "object") {
		for (const key of Object.keys(labels)) {
			if (isNearzeroDomainLabel(key, appName)) {
				delete labels[key];
			}
		}
	}
};

const hasNearzeroDomainLabels = (
	labels: DefinitionsService["labels"] | undefined,
	appName: string,
) => {
	if (Array.isArray(labels)) {
		return labels.some((label) => {
			const key = labelKey(label);
			return (
				key === NEARZERO_ROUTING_MARKER || isNearzeroDomainLabel(key, appName)
			);
		});
	}
	return Boolean(
		labels &&
			Object.keys(labels).some(
				(key) =>
					key === NEARZERO_ROUTING_MARKER ||
					isNearzeroDomainLabel(key, appName),
			),
	);
};

const removeComposeLabel = (
	labels: DefinitionsService["labels"] | undefined,
	key: string,
	expectedValue?: string,
) => {
	if (Array.isArray(labels)) {
		for (let index = labels.length - 1; index >= 0; index -= 1) {
			const label = labels[index] ?? "";
			const separator = label.indexOf("=");
			const value = separator === -1 ? "" : label.slice(separator + 1);
			if (
				labelKey(label) === key &&
				(expectedValue === undefined || value === expectedValue)
			) {
				labels.splice(index, 1);
			}
		}
		return;
	}
	if (
		labels &&
		Object.hasOwn(labels, key) &&
		(expectedValue === undefined || String(labels[key]) === expectedValue)
	) {
		delete labels[key];
	}
};

const addComposeLabel = (
	labels: NonNullable<DefinitionsService["labels"]>,
	label: string,
	prepend = false,
) => {
	const separator = label.indexOf("=");
	if (separator < 1) {
		throw new Error("Invalid generated Docker Compose label");
	}
	const key = label.slice(0, separator);
	const value = label.slice(separator + 1);
	if (Array.isArray(labels)) {
		for (let index = labels.length - 1; index >= 0; index -= 1) {
			if (labelKey(labels[index] ?? "") === key) labels.splice(index, 1);
		}
		if (prepend) labels.unshift(label);
		else labels.push(label);
		return;
	}
	labels[key] = value;
};

export const cloneCompose = async (
	compose: Compose,
): Promise<PreparedShellCommand> => {
	const prepared: PreparedShellCommand = { command: "set -e;" };
	const entity = {
		...compose,
		type: "compose" as const,
	};
	if (compose.sourceType === "github") {
		const gitClone = await cloneGithubRepository(entity);
		prepared.command += gitClone.command;
		prepared.input = gitClone.input;
	} else if (compose.sourceType === "gitlab") {
		const gitClone = await cloneGitlabRepository(entity);
		prepared.command += gitClone.command;
		prepared.input = gitClone.input;
	} else if (compose.sourceType === "bitbucket") {
		const gitClone = await cloneBitbucketRepository(entity);
		prepared.command += gitClone.command;
		prepared.input = gitClone.input;
	} else if (compose.sourceType === "git") {
		const gitClone = await cloneGitRepository(entity);
		prepared.command += gitClone.command;
		prepared.input = gitClone.input;
	} else if (compose.sourceType === "gitea") {
		const gitClone = await cloneGiteaRepository(entity);
		prepared.command += gitClone.command;
		prepared.input = gitClone.input;
	} else if (compose.sourceType === "raw") {
		prepared.command += getCreateComposeFileCommand(compose);
	}
	return prepared;
};

export const getComposePath = (compose: Compose) => {
	const { COMPOSE_PATH } = paths(!!compose.serverId);
	const { appName, sourceType, composePath } = compose;
	assertTraefikName(appName, "Application name", 63);
	const projectPath = path.resolve(COMPOSE_PATH, appName, "code");
	const relativePath =
		sourceType === "raw" ? "docker-compose.yml" : composePath.trim();
	if (
		!relativePath ||
		path.isAbsolute(relativePath) ||
		relativePath.includes("\0")
	) {
		throw new Error(
			"Compose file path must be relative to its project directory",
		);
	}
	const composeFilePath = path.resolve(projectPath, relativePath);
	if (
		composeFilePath === projectPath ||
		!composeFilePath.startsWith(`${projectPath}${path.sep}`)
	) {
		throw new Error("Compose file path escapes its project directory");
	}
	return composeFilePath;
};

export const getComposeProjectPath = (compose: Compose) =>
	path.resolve(paths(!!compose.serverId).COMPOSE_PATH, compose.appName, "code");

export const loadDockerCompose = async (
	compose: Compose,
): Promise<ComposeSpecification | null> => {
	const path = getComposePath(compose);

	if (existsSync(path)) {
		const yamlStr = readFileSync(path, "utf8");
		const parsedConfig = parse(yamlStr, {
			maxAliasCount: 10000,
		}) as ComposeSpecification;
		return parsedConfig;
	}
	return null;
};

export const loadDockerComposeRemote = async (
	compose: Compose,
): Promise<ComposeSpecification | null> => {
	const path = getComposePath(compose);
	try {
		if (!compose.serverId) {
			return null;
		}
		const { stdout, stderr } = await execAsyncRemote(
			compose.serverId,
			`cat -- ${quote([path])}`,
		);

		if (stderr) {
			return null;
		}
		if (!stdout) return null;
		const parsedConfig = parse(stdout, {
			maxAliasCount: 10000,
		}) as ComposeSpecification;
		return parsedConfig;
	} catch {
		return null;
	}
};

export const readComposeFile = async (compose: Compose) => {
	const path = getComposePath(compose);
	if (existsSync(path)) {
		const yamlStr = readFileSync(path, "utf8");
		return yamlStr;
	}
	return null;
};

export const writeDomainsToCompose = async (
	compose: Compose,
	domains: Domain[],
) => {
	try {
		const composeConverted = await addDomainToCompose(compose, domains);
		const path = getComposePath(compose);

		if (!composeConverted) {
			return `
echo "❌ Error: Compose file not found";
exit 1;
			`;
		}

		const composeString = stringify(composeConverted, { lineWidth: 1000 });
		const encodedContent = encodeBase64(composeString);
		const pathArgument = quote([path]);
		return `nearzero_compose_directory=$(dirname -- ${pathArgument});
nearzero_compose_candidate=$(mktemp "$nearzero_compose_directory/.nearzero-domain-labels.XXXXXX");
trap 'rm -f -- "$nearzero_compose_candidate"' EXIT;
printf '%s' '${encodedContent}' | base64 -d > "$nearzero_compose_candidate";
chmod 600 "$nearzero_compose_candidate";
mv -f -- "$nearzero_compose_candidate" ${pathArgument};
nearzero_compose_candidate='';
trap - EXIT;`;
	} catch {
		// Do not interpolate parser or validation errors into the generated shell
		// command: Compose content is user-controlled and may contain shell syntax
		// or secrets. The generated deployment command receives a generic failure.
		return `echo "❌ Error: Could not update Compose domain routing labels";
exit 1;
		`;
	}
};
export const addDomainToCompose = async (
	compose: Compose,
	domains: Domain[],
	options: { applyDeploymentTransforms?: boolean } = {},
) => {
	let result: ComposeSpecification | null;

	if (compose.serverId) {
		result = await loadDockerComposeRemote(compose);
	} else {
		result = await loadDockerCompose(compose);
	}

	if (!result) {
		return null;
	}
	return reconcileDomainsInComposeSpecification(
		compose,
		domains,
		result,
		options,
	);
};

/**
 * Reconcile Nearzero-owned routing labels in an already parsed Compose file.
 * Live routing updates pass `applyDeploymentTransforms: false` because the
 * cached deployment file has already had randomization/isolation transforms
 * applied and applying them twice would corrupt service names and volumes.
 */
export const reconcileDomainsInComposeSpecification = (
	compose: Compose,
	domains: Domain[],
	composeSpecification: ComposeSpecification,
	options: { applyDeploymentTransforms?: boolean } = {},
) => {
	const { appName } = compose;
	let result = composeSpecification;
	assertTraefikName(appName, "Application name", 63);

	if (
		options.applyDeploymentTransforms !== false &&
		compose.isolatedDeployment
	) {
		const randomized = randomizeDeployableSpecificationFile(
			result,
			compose.isolatedDeploymentsVolume,
			compose.suffix || compose.appName,
		);
		result = randomized;
	} else if (options.applyDeploymentTransforms !== false && compose.randomize) {
		const randomized = randomizeSpecificationFile(result, compose.suffix);
		result = randomized;
	}

	if (!result.services || typeof result.services !== "object") {
		throw new Error("Compose file does not define any services");
	}

	const uniqueConfigKeys = new Set<number>();
	for (const domain of domains) {
		validateDomainLabelInputs(
			appName,
			domain,
			domain.customEntrypoint || "web",
		);
		if (
			!domain.serviceName ||
			!COMPOSE_SERVICE_PATTERN.test(domain.serviceName)
		) {
			throw new Error("Compose domain has an invalid service name");
		}
		if (!Object.hasOwn(result.services, domain.serviceName)) {
			throw new Error(
				`Compose service "${domain.serviceName}" does not exist in the compose file`,
			);
		}
		if (uniqueConfigKeys.has(domain.uniqueConfigKey)) {
			throw new Error("Compose domains must have unique configuration keys");
		}
		uniqueConfigKeys.add(domain.uniqueConfigKey);
	}

	// Reconcile the full generated-label namespace on every build. This removes
	// routers left behind when a domain is deleted, moved to another service, or
	// changes entrypoints/TLS settings, while preserving user-authored labels.
	const previouslyManagedServices = new Set<string>();
	for (const [serviceName, service] of Object.entries(result.services)) {
		if (
			hasNearzeroDomainLabels(service.labels, appName) ||
			hasNearzeroDomainLabels(service.deploy?.labels, appName)
		) {
			previouslyManagedServices.add(serviceName);
		}
		removeNearzeroDomainLabels(service.labels, appName);
		removeNearzeroDomainLabels(service.deploy?.labels, appName);
		removeComposeLabel(service.labels, NEARZERO_ROUTING_MARKER);
		removeComposeLabel(service.deploy?.labels, NEARZERO_ROUTING_MARKER);
	}

	for (const domain of domains) {
		const { serviceName, https } = domain;
		if (!serviceName) {
			throw new Error("Compose domain is missing its service name");
		}
		const service = result.services[serviceName];
		if (!service) {
			throw new Error(
				"Compose domain service disappeared during reconciliation",
			);
		}

		const httpLabels = createDomainLabels(
			appName,
			domain,
			domain.customEntrypoint || "web",
		);
		if (!domain.customEntrypoint && https) {
			const httpsLabels = createDomainLabels(appName, domain, "websecure");
			httpLabels.push(...httpsLabels);
		}

		let labels: DefinitionsService["labels"] = [];
		if (compose.composeType === "docker-compose") {
			if (!service.labels) {
				service.labels = [];
			}

			labels = service.labels;
		} else {
			// Stack Case
			if (!service.deploy) {
				service.deploy = {};
			}
			if (!service.deploy.labels) {
				service.deploy.labels = [];
			}

			labels = service.deploy.labels;
		}

		for (const label of httpLabels) {
			addComposeLabel(labels, label, true);
		}
		addComposeLabel(labels, `${NEARZERO_ROUTING_MARKER}=true`, true);
		addComposeLabel(labels, "traefik.enable=true", true);
		if (!compose.isolatedDeployment) {
			addComposeLabel(
				labels,
				compose.composeType === "docker-compose"
					? "traefik.docker.network=nearzero-network"
					: "traefik.swarm.network=nearzero-network",
				true,
			);
		}

		if (!compose.isolatedDeployment) {
			// Add the nearzero-network to the service
			service.networks = addNearzeroNetworkToService(service.networks);
		}
	}

	const desiredServiceNames = new Set(
		domains.map((domain) => domain.serviceName).filter(Boolean),
	);
	for (const serviceName of previouslyManagedServices) {
		if (desiredServiceNames.has(serviceName)) continue;
		const service = result.services[serviceName];
		if (!service) continue;
		for (const labels of [service.labels, service.deploy?.labels]) {
			removeComposeLabel(labels, "traefik.enable", "true");
			removeComposeLabel(labels, "traefik.docker.network", "nearzero-network");
			removeComposeLabel(labels, "traefik.swarm.network", "nearzero-network");
		}
	}

	// Add nearzero-network to the root of the compose file
	if (!compose.isolatedDeployment) {
		result.networks = addNearzeroNetworkToRoot(result.networks);
	}

	return result;
};

export const writeComposeFile = async (
	compose: Compose,
	composeSpec: ComposeSpecification,
) => {
	const path = getComposePath(compose);

	try {
		const composeFile = stringify(composeSpec, {
			lineWidth: 1000,
		});
		fs.writeFileSync(path, composeFile, "utf8");
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};

const toPunycode = (host: string): string => domainToASCII(host).toLowerCase();

export const createDomainLabels = (
	appName: string,
	domain: Domain,
	entrypoint: string,
) => {
	validateDomainLabelInputs(appName, domain, entrypoint);
	const {
		host,
		port,
		customEntrypoint,
		https,
		uniqueConfigKey,
		certificateType,
		path,
		customCertResolver,
		stripPath,
		internalPath,
	} = domain;
	const routerName = `${appName}-${uniqueConfigKey}-${entrypoint}`;
	const punycodeHost = toPunycode(host);
	const labels = [
		`traefik.http.routers.${routerName}.rule=Host(\`${punycodeHost}\`)${path && path !== "/" ? ` && PathPrefix(\`${path}\`)` : ""}`,
		`traefik.http.routers.${routerName}.entrypoints=${entrypoint}`,
		`traefik.http.services.${routerName}.loadbalancer.server.port=${port}`,
		`traefik.http.routers.${routerName}.service=${routerName}`,
	];

	// Collect middlewares for this router
	const middlewares: string[] = [];
	const isRedirectRouter = entrypoint === "web" && https && !customEntrypoint;

	// Web router with HTTPS only needs redirect — all other middlewares
	// run on the websecure router where the request actually lands.
	if (isRedirectRouter) {
		middlewares.push("redirect-to-https@file");
	}

	// Add stripPath middleware if needed
	if (stripPath && path && path !== "/") {
		const middlewareName = `stripprefix-${appName}-${uniqueConfigKey}`;
		// Define middleware on web (or custom) entrypoint so Traefik registers it
		if (entrypoint === "web" || customEntrypoint) {
			labels.push(
				`traefik.http.middlewares.${middlewareName}.stripprefix.prefixes=${path}`,
			);
		}
		if (!isRedirectRouter) {
			middlewares.push(middlewareName);
		}
	}

	// Add internalPath middleware if needed
	if (internalPath && internalPath !== "/" && internalPath.startsWith("/")) {
		const middlewareName = `addprefix-${appName}-${uniqueConfigKey}`;
		// Define middleware on web (or custom) entrypoint so Traefik registers it
		if (entrypoint === "web" || customEntrypoint) {
			labels.push(
				`traefik.http.middlewares.${middlewareName}.addprefix.prefix=${internalPath}`,
			);
		}
		if (!isRedirectRouter) {
			middlewares.push(middlewareName);
		}
	}

	// Add custom middlewares (skip for redirect-only router)
	if (!isRedirectRouter && domain.middlewares?.length) {
		middlewares.push(...domain.middlewares);
	}

	// Apply middlewares to router if any exist
	if (middlewares.length > 0) {
		labels.push(
			`traefik.http.routers.${routerName}.middlewares=${middlewares.join(",")}`,
		);
	}

	// Add TLS configuration for websecure
	const isTlsRouter =
		https && (entrypoint === "websecure" || entrypoint === customEntrypoint);
	if (isTlsRouter) {
		if (certificateType === "letsencrypt") {
			labels.push(
				`traefik.http.routers.${routerName}.tls.certresolver=letsencrypt`,
			);
		} else if (certificateType === "custom" && customCertResolver) {
			labels.push(
				`traefik.http.routers.${routerName}.tls.certresolver=${customCertResolver}`,
			);
		} else if (certificateType === "none") {
			// No cert resolver, but HTTPS is enabled (default/custom certificate):
			// explicitly enable TLS so Traefik serves the router over HTTPS.
			labels.push(`traefik.http.routers.${routerName}.tls=true`);
		}
	}

	return labels;
};

export const addNearzeroNetworkToService = (
	networkService: DefinitionsService["networks"],
) => {
	let networks = networkService;
	const network = "nearzero-network";
	const defaultNetwork = "default";
	if (!networks) {
		networks = [];
	}

	if (Array.isArray(networks)) {
		if (!networks.includes(network)) {
			networks.push(network);
		}
		if (!networks.includes(defaultNetwork)) {
			networks.push(defaultNetwork);
		}
	} else if (networks && typeof networks === "object") {
		if (!(network in networks)) {
			networks[network] = {};
		}
		if (!(defaultNetwork in networks)) {
			networks[defaultNetwork] = {};
		}
	}

	return networks;
};

export const addNearzeroNetworkToRoot = (
	networkRoot: PropertiesNetworks | undefined,
) => {
	let networks = networkRoot;
	const network = "nearzero-network";

	if (!networks) {
		networks = {};
	}

	if (networks[network] || !networks[network]) {
		networks[network] = {
			external: true,
		};
	}

	return networks;
};
