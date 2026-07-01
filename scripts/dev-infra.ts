#!/usr/bin/env bun
/**
 * Start only the local Docker-backed development infrastructure.
 */
import {
	ensureDevInfra,
	ensureEnvFiles,
	ensureMonitoringImage,
	printDevUrls,
} from "./lib/dev-utils";

ensureEnvFiles({ localInfra: true });
await ensureDevInfra();
ensureMonitoringImage();
printDevUrls({ console: false, platform: false, infra: true });
