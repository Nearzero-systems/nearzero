const BASE = process.env.CONSOLE_URL || "http://localhost:4321";

async function followRedirects(path: string, max = 12) {
	const chain: string[] = [];
	let url = new URL(path, BASE).toString();

	for (let i = 0; i < max; i++) {
		chain.push(url);
		const res = await fetch(url, { redirect: "manual" });
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			if (!location) break;
			url = new URL(location, url).toString();
			continue;
		}
		return { status: res.status, finalUrl: url, chain, loop: false };
	}

	const loop = chain.length >= max;
	return { status: 0, finalUrl: url, chain, loop: loop || chain.includes(url) };
}

const paths = [
	"/",
	"/register",
	"/register?step=profile",
	"/register?token=test&email=invitee@example.com",
	"/invitation?token=test",
	"/dashboard/agent",
	"/EXuAPpi9lz/dashboard/agent",
];

let failed = false;
for (const path of paths) {
	const result = await followRedirects(path);
	const ok = !result.loop && result.chain.length <= 10;
	if (!ok) failed = true;
	console.log(
		`${ok ? "OK" : "FAIL"} ${path} -> status=${result.status} hops=${result.chain.length - 1} final=${result.finalUrl}`,
	);
	if (result.loop) {
		console.log("  redirect chain:", result.chain.join(" -> "));
	}
}

if (failed) process.exit(1);
console.log("redirect checks passed");
