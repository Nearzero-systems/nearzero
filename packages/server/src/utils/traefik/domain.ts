import { domainToASCII } from "node:url";
import {
	isSafeTraefikRuleFragment,
	isValidDomainHost,
} from "@nearzero/server/db/validations/domain";
import type { Domain } from "@nearzero/server/services/domain";
import type { ApplicationNested } from "../builders";
import {
	createServiceConfig,
	loadOrCreateConfig,
	loadOrCreateConfigRemote,
	removeTraefikConfig,
	removeTraefikConfigRemote,
	withTraefikMutationLock,
	writeTraefikConfig,
	writeTraefikConfigRemote,
} from "./application";
import type { FileConfig, HttpRouter } from "./file-types";
import { createPathMiddlewares, removePathMiddlewares } from "./middleware";

const TRAEFIK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const TRAEFIK_MIDDLEWARE_PATTERN =
	/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:@[A-Za-z0-9][A-Za-z0-9_.-]*)?$/;

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

const validateRouterInputs = (
	appName: string,
	domain: Domain,
	entryPoint: string,
) => {
	assertTraefikName(appName, "Application name", 63);
	assertTraefikName(entryPoint, "Traefik entrypoint");
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
};

const manageDomainUnlocked = async (app: ApplicationNested, domain: Domain) => {
	const { appName } = app;
	let config: FileConfig;

	if (app.serverId) {
		config = await loadOrCreateConfigRemote(app.serverId, appName);
	} else {
		config = loadOrCreateConfig(appName);
	}
	const serviceName = `${appName}-service-${domain.uniqueConfigKey}`;
	const routerName = `${appName}-router-${domain.uniqueConfigKey}`;
	const routerNameSecure = `${appName}-router-websecure-${domain.uniqueConfigKey}`;

	config.http = config.http || { routers: {}, services: {} };
	config.http.routers = config.http.routers || {};
	config.http.services = config.http.services || {};

	config.http.routers[routerName] = await createRouterConfig(
		app,
		domain,
		domain.customEntrypoint || "web",
	);

	if (!domain.customEntrypoint && domain.https) {
		config.http.routers[routerNameSecure] = await createRouterConfig(
			app,
			domain,
			"websecure",
		);
	} else {
		delete config.http.routers[routerNameSecure];
	}

	config.http.services[serviceName] = createServiceConfig(appName, domain);

	await createPathMiddlewares(app, domain);

	if (app.serverId) {
		await writeTraefikConfigRemote(config, appName, app.serverId);
	} else {
		writeTraefikConfig(config, appName);
	}
};

export const manageDomain = async (app: ApplicationNested, domain: Domain) =>
	withTraefikMutationLock(app.serverId, () =>
		manageDomainUnlocked(app, domain),
	);

const removeDomainUnlocked = async (
	application: ApplicationNested,
	uniqueKey: number,
) => {
	const { appName, serverId } = application;
	let config: FileConfig;

	if (serverId) {
		config = await loadOrCreateConfigRemote(serverId, appName);
	} else {
		config = loadOrCreateConfig(appName);
	}

	const routerKey = `${appName}-router-${uniqueKey}`;
	const routerSecureKey = `${appName}-router-websecure-${uniqueKey}`;

	const serviceKey = `${appName}-service-${uniqueKey}`;
	if (config.http?.routers?.[routerKey]) {
		delete config.http.routers[routerKey];
	}
	if (config.http?.routers?.[routerSecureKey]) {
		delete config.http.routers[routerSecureKey];
	}
	if (config.http?.services?.[serviceKey]) {
		delete config.http.services[serviceKey];
	}

	await removePathMiddlewares(application, uniqueKey);

	// verify if is the last router if so we delete the router
	if (
		config?.http?.routers &&
		Object.keys(config?.http?.routers).length === 0
	) {
		if (serverId) {
			await removeTraefikConfigRemote(appName, serverId);
		} else {
			await removeTraefikConfig(appName);
		}
	} else {
		if (serverId) {
			await writeTraefikConfigRemote(config, appName, serverId);
		} else {
			writeTraefikConfig(config, appName);
		}
	}
};

export const removeDomain = async (
	application: ApplicationNested,
	uniqueKey: number,
) =>
	withTraefikMutationLock(application.serverId, () =>
		removeDomainUnlocked(application, uniqueKey),
	);

/**
 * Converts an internationalized domain name (IDN) to ASCII punycode format.
 * Traefik requires domain names in ASCII format, so non-ASCII characters
 * must be converted (e.g., "тест.рф" → "xn--e1aybc.xn--p1ai").
 */
const toPunycode = (host: string): string => domainToASCII(host).toLowerCase();

export const createRouterConfig = async (
	app: ApplicationNested,
	domain: Domain,
	entryPoint: string,
) => {
	const { appName, redirects, security } = app;
	const { certificateType } = domain;
	validateRouterInputs(appName, domain, entryPoint);

	const {
		host,
		path,
		https,
		uniqueConfigKey,
		internalPath,
		stripPath,
		customEntrypoint,
	} = domain;
	const punycodeHost = toPunycode(host);
	const routerConfig: HttpRouter = {
		rule: `Host(\`${punycodeHost}\`)${path !== null && path !== "/" ? ` && PathPrefix(\`${path}\`)` : ""}`,
		service: `${appName}-service-${uniqueConfigKey}`,
		middlewares: [],
		entryPoints: [entryPoint],
	};

	const isRedirectRouter = entryPoint === "web" && https && !customEntrypoint;

	// Web router with HTTPS only needs redirect — all other middlewares
	// run on the websecure router where the request actually lands.
	if (isRedirectRouter) {
		routerConfig.middlewares?.push("redirect-to-https");
	} else {
		// Add path rewriting middleware if needed
		// stripPrefix must come before addPrefix so Traefik strips the
		// public path first, then prepends the internal path.
		if (stripPath && path && path !== "/") {
			const stripMiddleware = `stripprefix-${appName}-${uniqueConfigKey}`;
			routerConfig.middlewares?.push(stripMiddleware);
		}

		if (internalPath && internalPath !== "/" && internalPath !== path) {
			const pathMiddleware = `addprefix-${appName}-${uniqueConfigKey}`;
			routerConfig.middlewares?.push(pathMiddleware);
		}

		// redirects - skip for preview deployments as wildcard subdomains
		// should not inherit parent redirect rules (e.g., www-redirect)
		if (domain.domainType !== "preview") {
			for (const redirect of redirects) {
				const middlewareName = `redirect-${appName}-${redirect.uniqueConfigKey}`;
				routerConfig.middlewares?.push(middlewareName);
			}
		}

		// security
		if (security.length > 0) {
			let middlewareName = `auth-${appName}`;
			if (domain.domainType === "preview") {
				middlewareName = `auth-${appName.replace(
					/^preview-(.+)-[^-]+$/,
					"$1",
				)}`;
			}
			routerConfig.middlewares?.push(middlewareName);
		}

		// custom middlewares from domain
		if (domain.middlewares && domain.middlewares.length > 0) {
			routerConfig.middlewares?.push(...domain.middlewares);
		}
	}

	const isTlsRouter =
		https && (entryPoint === "websecure" || entryPoint === customEntrypoint);
	if (isTlsRouter) {
		if (certificateType === "letsencrypt") {
			routerConfig.tls = { certResolver: "letsencrypt" };
		} else if (certificateType === "custom" && domain.customCertResolver) {
			routerConfig.tls = { certResolver: domain.customCertResolver };
		} else if (certificateType === "none") {
			// An empty TLS object enables HTTPS while relying on Traefik's default
			// certificate instead of invoking an ACME certificate resolver.
			routerConfig.tls = {};
		}
	}

	return routerConfig;
};
