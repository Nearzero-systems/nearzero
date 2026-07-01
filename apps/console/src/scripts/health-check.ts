import { showToast } from "@/scripts/ui";

const HEALTH_CHECK_URL = "/api/health";

export type HealthCheckOptions = {
	initialDelay?: number;
	pollInterval?: number;
	successMessage: string;
	onSuccess?: () => void | Promise<void>;
	reloadOnSuccess?: boolean;
};

async function checkHealth(): Promise<boolean> {
	try {
		const response = await fetch(HEALTH_CHECK_URL);
		return response.ok;
	} catch {
		return false;
	}
}

async function pollUntilHealthy(
	pollInterval: number,
	successMessage: string,
	onSuccess?: () => void | Promise<void>,
	reloadOnSuccess = false,
): Promise<void> {
	if (await checkHealth()) {
		showToast(successMessage, "success");
		if (reloadOnSuccess) {
			window.setTimeout(() => window.location.reload(), 2000);
		} else {
			await onSuccess?.();
		}
		return;
	}
	await new Promise((resolve) => window.setTimeout(resolve, pollInterval));
	await pollUntilHealthy(pollInterval, successMessage, onSuccess, reloadOnSuccess);
}

export async function executeWithHealthCheck<T>(
	mutationFn: () => Promise<T>,
	options: HealthCheckOptions,
): Promise<T> {
	const {
		initialDelay = 5000,
		pollInterval = 4000,
		successMessage,
		onSuccess,
		reloadOnSuccess = false,
	} = options;

	const result = await mutationFn();
	await new Promise((resolve) => window.setTimeout(resolve, initialDelay));
	await pollUntilHealthy(pollInterval, successMessage, onSuccess, reloadOnSuccess);
	return result;
}
