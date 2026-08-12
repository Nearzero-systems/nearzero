import { describe, expect, it } from "vitest";
import {
	activationHttpsVerificationMessage,
	currentActivationStep,
	firstApplicationSetupPath,
	firstProjectWorkspacePath,
	httpsUrlForHost,
	normalizeActivationHttpsVerification,
	normalizeActivationStatus,
} from "./get-started";

function response() {
	return {
		complete: false,
		canManage: true,
		completed: 3,
		total: 5,
		steps: {
			runtime: {
				complete: true,
				local: { ready: true },
				readyRemoteCount: 1,
			},
			source: {
				complete: true,
				gitProviderCount: 2,
				mode: "direct_git",
			},
			project: {
				complete: true,
				projectCount: 1,
				environmentCount: 2,
				first: {
					projectId: "project one",
					environmentId: "env/production",
					name: "First app",
				},
			},
			service: {
				complete: true,
				count: 1,
				first: {
					kind: "application",
					id: "app-1",
					name: "Web",
					status: "running",
				},
			},
			deployment: {
				complete: false,
				status: "running",
				deploymentId: "deployment-1",
				serviceId: "app-1",
				serviceKind: "application",
			},
			domain: {
				complete: false,
				configured: true,
				count: 1,
				httpsCount: 0,
				host: "app.example.com",
			},
		},
	};
}

describe("get-started activation adapter", () => {
	it("normalizes the exact server-derived activation contract", () => {
		const status = normalizeActivationStatus(response());
		expect(status.completed).toBe(3);
		expect(status.canManage).toBe(true);
		expect(status.steps.runtime.readyRemoteCount).toBe(1);
		expect(status.steps.source.mode).toBe("direct_git");
		expect(status.steps.project.first?.name).toBe("First app");
		expect(status.steps.deployment.status).toBe("running");
		expect(status.steps.domain.host).toBe("app.example.com");
		expect(status.steps.domain.configured).toBe(true);
	});

	it("fails closed when response fields are missing or malformed", () => {
		const status = normalizeActivationStatus({
			complete: "yes",
			completed: -2,
			steps: {
				runtime: { complete: 1, readyRemoteCount: Number.NaN },
				project: { first: { projectId: "p", environmentId: "" } },
				deployment: { status: "successful" },
				domain: { host: 123 },
			},
		});

		expect(status.complete).toBe(false);
		expect(status.completed).toBe(0);
		expect(status.steps.runtime.complete).toBe(false);
		expect(status.steps.project.first).toBeNull();
		expect(status.steps.deployment.status).toBe("not_started");
		expect(status.steps.domain.host).toBeNull();
	});

	it("resumes at the first incomplete real gate", () => {
		const running = normalizeActivationStatus(response());
		expect(currentActivationStep(running)).toBe("deployment");

		const ready = normalizeActivationStatus({
			...response(),
			complete: true,
			steps: {
				...response().steps,
				deployment: {
					...response().steps.deployment,
					complete: true,
					status: "done",
				},
				domain: {
					...response().steps.domain,
					complete: true,
					httpsCount: 1,
				},
			},
		});
		expect(currentActivationStep(ready)).toBe("https");
		expect(currentActivationStep(ready, { httpsVerified: true })).toBe(
			"complete",
		);
	});

	it("creates encoded links only when a real project environment exists", () => {
		const status = normalizeActivationStatus(response());
		expect(firstProjectWorkspacePath(status)).toBe(
			"/dashboard/project/project%20one/environment/env%2Fproduction/overview",
		);
		expect(firstApplicationSetupPath(status, "git")).toBe(
			"/dashboard/project/project%20one/environment/env%2Fproduction/services/application/new",
		);
		expect(firstApplicationSetupPath(status, "image")).toBe(
			"/dashboard/project/project%20one/environment/env%2Fproduction/services/application/new?mode=empty&source=docker",
		);
		expect(
			firstApplicationSetupPath(normalizeActivationStatus(null), "git"),
		).toBeNull();
	});

	it("only turns plain hosts into canonical HTTPS links", () => {
		expect(httpsUrlForHost("app.example.com.")).toBe("https://app.example.com");
		expect(httpsUrlForHost("example.com/path")).toBeNull();
		expect(httpsUrlForHost("user@example.com")).toBeNull();
		expect(httpsUrlForHost(null)).toBeNull();
	});

	it("keeps configured HTTPS separate from a live verification result", () => {
		const verified = normalizeActivationHttpsVerification({
			configured: true,
			verified: true,
			host: "app.example.com",
			status: "verified",
			code: "HTTPS_VERIFIED",
			body: "must not be copied",
		});
		expect(verified).toEqual({
			configured: true,
			verified: true,
			host: "app.example.com",
			status: "verified",
			code: "HTTPS_VERIFIED",
		});
		expect(activationHttpsVerificationMessage(verified)).toContain(
			"public DNS, TLS",
		);

		const malformed = normalizeActivationHttpsVerification({
			configured: true,
			verified: true,
			status: "failed",
			code: "HTTPS_VERIFIED",
			host: "app.example.com",
		});
		expect(malformed.verified).toBe(false);
		expect(malformed.code).toBe("HTTPS_VERIFIED");
	});
});
