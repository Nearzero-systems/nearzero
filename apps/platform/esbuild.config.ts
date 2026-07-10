import dotenv, { type DotenvParseOutput } from "dotenv";
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const editionEntryPoints = {
	"@nearzero/edition-community": path.resolve(
		__dirname,
		"../../packages/edition-community/src/index.ts",
	),
	"@nearzero/edition-contract": path.resolve(
		__dirname,
		"../../packages/edition-contract/src/index.ts",
	),
};

const bundleEditionPackages: esbuild.Plugin = {
	name: "bundle-edition-packages",
	setup(build) {
		build.onResolve(
			{ filter: /^@nearzero\/edition-(community|contract)$/ },
			(args) => ({
				path: editionEntryPoints[
					args.path as keyof typeof editionEntryPoints
				]!,
			}),
		);
	},
};

const result = dotenv.config({ path: ".env.production" });

function prepareDefine(config: DotenvParseOutput | undefined) {
	const define = {};
	// @ts-ignore
	for (const [key, value] of Object.entries(config)) {
		// Keep runtime secrets on the server — do not bake into the bundle at build time.
		if (key === "DATABASE_URL" || key === "REDIS_URL") {
			continue;
		}
		// @ts-ignore
		define[`process.env.${key}`] = JSON.stringify(value);
	}
	return define;
}

const define = prepareDefine(result.parsed);

try {
	esbuild
		.build({
			entryPoints: {
				server: "server/server.ts",
				migration: "migration.ts",
				"wait-for-postgres": "wait-for-postgres.ts",
				"reset-2fa": "reset-2fa.ts",
				"migrate-auth-secret": "scripts/migrate-auth-secret.ts",
			},
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node18",
			outExtension: { ".js": ".mjs" },
			minify: true,
			sourcemap: true,
			outdir: "dist",
			tsconfig: "tsconfig.server.json",
			define,
			plugins: [bundleEditionPackages],
			packages: "external",
		})
		.catch(() => {
			return process.exit(1);
		});
} catch (error) {
	console.log(error);
}
