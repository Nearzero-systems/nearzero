import esbuild from "esbuild";

await esbuild.build({
	entryPoints: {
		index: "src/index.ts",
	},
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node24",
	outdir: "dist",
	sourcemap: true,
	packages: "external",
});
