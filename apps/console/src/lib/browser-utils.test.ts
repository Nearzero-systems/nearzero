import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomId } from "./browser-utils";

const realRandomUUID = crypto.randomUUID;

afterEach(() => {
	crypto.randomUUID = realRandomUUID;
});

describe("randomId", () => {
	it("works where the browser hides crypto.randomUUID", () => {
		// @ts-expect-error simulates a plain-HTTP page
		crypto.randomUUID = undefined;
		const first = randomId();
		expect(first).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(randomId()).not.toBe(first);
	});
});

describe("plain-HTTP installs", () => {
	it("keeps browser code off APIs that only exist on HTTPS", () => {
		const root = join(import.meta.dir, "..");
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name);
				if (statSync(path).isDirectory()) {
					walk(path);
				} else if (
					/\.(astro|ts|tsx)$/.test(name) &&
					!/browser-utils(\.test)?\.ts$/.test(name) &&
					/crypto\.randomUUID|crypto\.subtle|navigator\.clipboard/.test(
						readFileSync(path, "utf8"),
					)
				) {
					offenders.push(path.slice(root.length + 1));
				}
			}
		};
		walk(root);
		expect(offenders).toEqual([]);
	});
});
