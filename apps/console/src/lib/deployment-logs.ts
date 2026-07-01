/** Short Git commit id from deployment.description (`Commit: <hash>`). */
export function extractDeploymentCommitId(dep: {
	description?: string | null;
	title?: string | null;
}): string {
	const desc = String(dep?.description ?? "").trim();
	const fromDesc = desc.match(/Commit:\s*([0-9a-f]+)/i);
	if (fromDesc?.[1]) return fromDesc[1].slice(0, 7);

	const title = String(dep?.title ?? "").trim();
	const fromTitle = title.match(/\b([0-9a-f]{7,40})\b/i);
	if (fromTitle?.[1]) return fromTitle[1].slice(0, 7);

	return "";
}

export function normalizeDeploymentLogs(value: string): string {
	const pathCleaned = value
		.replace(/\r/g, "\n")
		.replace(/\/Users\/[^\s'"`]+\/Desktop\/[^\s'"`]+/g, "<workspace>")
		.replace(/\/private\/var\/folders\/[^\s'"`]+/g, "<temp>");
	const result: string[] = [];
	let lastProgress = "";
	for (const line of pathCleaned.split("\n")) {
		const trimmed = line.trim();
		const progressMatch = trimmed.match(
			/^(remote:\s*)?(Counting objects|Compressing objects|Receiving objects|Resolving deltas):\s+\d+%/i,
		);
		if (progressMatch) {
			lastProgress = line;
			continue;
		}
		if (lastProgress) {
			result.push(lastProgress);
			lastProgress = "";
		}
		result.push(line);
	}
	if (lastProgress) result.push(lastProgress);
	return result.join("\n").trim();
}

export function isDeploymentFailureLine(line: string): boolean {
	const text = line.trim().toLowerCase();
	if (!text) return false;
	return (
		text.includes("error") ||
		text.includes("failed") ||
		text.includes("fatal:") ||
		text.includes("build failed") ||
		text.includes("deployment failed")
	);
}

export function renderDeploymentLogOutput(
	output: HTMLElement,
	rawLogs: string,
): string {
	const normalized = normalizeDeploymentLogs(rawLogs);
	output.replaceChildren();

	if (!normalized) {
		output.textContent = "No build logs were written for this deployment yet.";
		return "";
	}

	const fragment = document.createDocumentFragment();
	for (const [index, line] of normalized.split("\n").entries()) {
		const isErrorLine = isDeploymentFailureLine(line);
		const row = document.createElement("div");
		row.className = isErrorLine
			? "nz-app-log-line nz-app-log-line--error"
			: "nz-app-log-line";

		const number = document.createElement("span");
		number.className = "nz-app-log-line__num";
		number.textContent = String(index + 1).padStart(3, "0");

		const text = document.createElement("span");
		text.className = "nz-app-log-line__text";
		text.textContent = line || " ";

		row.append(number, text);
		fragment.append(row);
	}
	output.append(fragment);
	return normalized;
}
