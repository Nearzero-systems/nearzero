import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";

const __filename = fileURLToPath(import.meta.url); // get the resolved path to the file
const __dirname = path.dirname(__filename);

const workspaceAliases: Record<string, string> = {
	"@nearzero/server": path.resolve(__dirname, "src"),
	"@nearzero/edition-contract": path.resolve(
		__dirname,
		"../edition-contract/src/index.ts",
	),
};

const bundleWorkspacePackages: Plugin = {
	name: "bundle-workspace-packages",
	setup(esbuild) {
		esbuild.onResolve(
			{ filter: /^@nearzero\/(server|edition-contract)(?:\/.*)?$/ },
			async (args) => {
				const [packageName, ...subpath] = args.path.split("/");
				const scopedPackageName = `${packageName}/${subpath.shift()}`;
				const target = workspaceAliases[scopedPackageName];
				if (!target) return;
				const candidate =
					scopedPackageName === "@nearzero/server" && subpath.length > 0
						? path.resolve(target, subpath.join("/"))
						: target;
				return esbuild.resolve(candidate, {
					kind: args.kind,
					resolveDir: __dirname,
				});
			},
		);
	},
};

build({
	entryPoints: ["./src/**/*.ts"],
	// outfile: "./dist/index.js",
	outdir: "./dist",
	bundle: true,
	minify: false,
	platform: "node",
	target: "esnext",
	format: "esm",
	plugins: [bundleWorkspacePackages],
	packages: "external",
	// Opcional: si deseas emitir declaraciones de tipos con esbuild-plugin-dts
})
	.then(() => {
		console.log("Build successful");
	})
	.catch(() => process.exit(1));
