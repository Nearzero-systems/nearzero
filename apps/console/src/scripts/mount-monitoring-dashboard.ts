import { trpcQuery } from "@/lib/client-api";

type MetricPoint = {
	timestamp: string;
	cpu: number;
	cpuModel?: string;
	cpuCores?: number;
	cpuPhysicalCores?: number;
	cpuSpeed?: number;
	memUsedGB?: number;
	memTotal?: number;
	diskUsed?: number;
	uptime?: number;
	distro?: string;
	kernel?: string;
	arch?: string;
};

type RootEx = HTMLElement & { __nzMonitoringTeardown?: () => void };

let pageLoadBound = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let history: MetricPoint[] = [];

function formatUptime(seconds: number) {
	const days = Math.floor(seconds / (24 * 60 * 60));
	const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
	const minutes = Math.floor((seconds % (60 * 60)) / 60);
	return `${days}d ${hours}h ${minutes}m`;
}

function finiteMetric(value: number | undefined) {
	const numberValue = Number(value);
	return Number.isFinite(numberValue) ? numberValue : 0;
}

function clampPercent(value: number) {
	if (!Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

function formatPercent(value: number) {
	return `${Math.round(clampPercent(value))}%`;
}

function formatGb(value: number) {
	return `${Number.isInteger(value) ? value : value.toFixed(1)} GB`;
}

function setMeter(id: string, percent: number) {
	const el = document.getElementById(id);
	if (el instanceof HTMLElement) {
		el.style.width = `${clampPercent(percent)}%`;
	}
}

function drawLineChart(canvas: HTMLCanvasElement, values: number[], color: string) {
	const ctx = canvas.getContext("2d");
	if (!ctx || values.length === 0) return;
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	canvas.width = w * devicePixelRatio;
	canvas.height = h * devicePixelRatio;
	ctx.scale(devicePixelRatio, devicePixelRatio);
	ctx.clearRect(0, 0, w, h);
	const max = Math.max(...values, 1);
	ctx.strokeStyle = color;
	ctx.lineWidth = 2;
	ctx.beginPath();
	values.forEach((v, i) => {
		const x = (i / Math.max(values.length - 1, 1)) * (w - 16) + 8;
		const y = h - 8 - (v / max) * (h - 16);
		if (i === 0) ctx.moveTo(x, y);
		else ctx.lineTo(x, y);
	});
	ctx.stroke();
}

function renderMetrics(latest: MetricPoint) {
	const uptimeEl = document.getElementById("nz-mon-uptime");
	const cpuEl = document.getElementById("nz-mon-cpu");
	const memEl = document.getElementById("nz-mon-mem");
	const diskEl = document.getElementById("nz-mon-disk");
	const cpuPercent = clampPercent(finiteMetric(latest.cpu));
	const memUsed = finiteMetric(latest.memUsedGB);
	const memTotal = finiteMetric(latest.memTotal);
	const memPercent = memTotal > 0 ? clampPercent((memUsed / memTotal) * 100) : 0;
	const diskPercent = clampPercent(finiteMetric(latest.diskUsed));
	if (uptimeEl) uptimeEl.textContent = formatUptime(finiteMetric(latest.uptime));
	if (cpuEl) cpuEl.textContent = formatPercent(cpuPercent);
	if (memEl) memEl.textContent = memTotal > 0 ? `${formatGb(memUsed)} / ${formatGb(memTotal)}` : "—";
	if (diskEl) diskEl.textContent = formatPercent(diskPercent);
	setMeter("nz-mon-cpu-bar", cpuPercent);
	setMeter("nz-mon-mem-bar", memPercent);
	setMeter("nz-mon-disk-bar", diskPercent);
	const cpuModel = document.getElementById("nz-mon-cpu-model");
	const cpuDetail = document.getElementById("nz-mon-cpu-detail");
	const osEl = document.getElementById("nz-mon-os");
	const kernelEl = document.getElementById("nz-mon-kernel");
	if (cpuModel) cpuModel.textContent = latest.cpuModel ?? "—";
	if (cpuDetail) {
		const ghz = finiteMetric(latest.cpuSpeed);
		const ghzLabel = ghz >= 100 ? (ghz / 1000).toFixed(2) : String(ghz);
		cpuDetail.textContent = `${latest.cpuPhysicalCores ?? 0} Physical Cores (${latest.cpuCores ?? 0} Threads) @ ${ghzLabel}GHz`;
	}
	if (osEl) osEl.textContent = latest.distro ?? "—";
	if (kernelEl) kernelEl.textContent = `Kernel: ${latest.kernel ?? "—"} (${latest.arch ?? "—"})`;

	const cpuCanvas = document.getElementById("nz-mon-cpu-chart");
	const memCanvas = document.getElementById("nz-mon-mem-chart");
	if (cpuCanvas instanceof HTMLCanvasElement) {
		drawLineChart(
			cpuCanvas,
			history.map((p) => finiteMetric(p.cpu)),
			"#2563eb",
		);
	}
	if (memCanvas instanceof HTMLCanvasElement) {
		drawLineChart(
			memCanvas,
			history.map((p) => {
				const total = finiteMetric(p.memTotal);
				const used = finiteMetric(p.memUsedGB);
				return total > 0 ? clampPercent((used / total) * 100) : used;
			}),
			"#059669",
		);
	}
}

async function fetchMetrics() {
	const dataPoints =
		(document.getElementById("nz-mon-data-points") as HTMLSelectElement | null)
			?.value ?? "50";
	const data = await trpcQuery<MetricPoint[]>("server.getServerMetrics", {
		dataPoints,
	});
	history = (data ?? []).map((m) => ({
		...m,
		cpu: Number.parseFloat(String(m.cpu)),
		memUsedGB: Number.parseFloat(String(m.memUsedGB)),
		memTotal: Number.parseFloat(String(m.memTotal)),
		diskUsed: Number.parseFloat(String(m.diskUsed)),
	}));
	const latest = history[history.length - 1];
	if (latest) renderMetrics(latest);
}

function clearPoll() {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

function bindMonitoringPage() {
	const root = document.getElementById("nz-monitoring-root");
	if (!(root instanceof HTMLElement)) {
		clearPoll();
		return;
	}

	const r = root as RootEx;
	r.__nzMonitoringTeardown?.();
	const ac = new AbortController();
	r.__nzMonitoringTeardown = () => {
		ac.abort();
		clearPoll();
	};

	const loading = document.getElementById("nz-monitoring-loading");
	const error = document.getElementById("nz-monitoring-error");
	const content = document.getElementById("nz-monitoring-content");
	const errorMsg = document.getElementById("nz-monitoring-error-msg");
	const opts = { signal: ac.signal };

	const schedule = () => {
		clearPoll();
		const refresh = Number.parseInt(
			(document.getElementById("nz-mon-refresh") as HTMLSelectElement | null)
				?.value ?? "5000",
			10,
		);
		const dataPoints =
			(document.getElementById("nz-mon-data-points") as HTMLSelectElement | null)
				?.value ?? "50";
		if (dataPoints !== "all") {
			pollTimer = setInterval(() => {
				void fetchMetrics().catch(() => {
					/* keep last good sample while polling */
				});
			}, refresh);
		}
	};

	loading?.classList.remove("hidden");
	error?.classList.add("hidden");
	content?.classList.add("hidden");

	void fetchMetrics()
		.then(() => {
			if (ac.signal.aborted) return;
			loading?.classList.add("hidden");
			content?.classList.remove("hidden");
			schedule();
		})
		.catch((err) => {
			if (ac.signal.aborted) return;
			loading?.classList.add("hidden");
			error?.classList.remove("hidden");
			if (errorMsg) {
				errorMsg.textContent =
					err instanceof Error ? err.message : "Failed to fetch metrics";
			}
		});

	document
		.getElementById("nz-mon-data-points")
		?.addEventListener(
			"change",
			() => {
				void fetchMetrics()
					.then(schedule)
					.catch((err) => {
						if (errorMsg) {
							errorMsg.textContent =
								err instanceof Error ? err.message : "Failed to fetch metrics";
						}
						error?.classList.remove("hidden");
						content?.classList.add("hidden");
					});
			},
			opts,
		);
	document
		.getElementById("nz-mon-refresh")
		?.addEventListener("change", schedule, opts);
}

export function mountMonitoringDashboard() {
	bindMonitoringPage();
	if (pageLoadBound) return;
	pageLoadBound = true;
	document.addEventListener("astro:page-load", bindMonitoringPage);
	document.addEventListener("astro:after-swap", bindMonitoringPage);
}
