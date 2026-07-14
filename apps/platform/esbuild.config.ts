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
			plugins: [bundleEditionPackages],
			packages: "external",
		})
		.catch(() => {
			return process.exit(1);
		});
} catch (error) {
	console.log(error);
}
