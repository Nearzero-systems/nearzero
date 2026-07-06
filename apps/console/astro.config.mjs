import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import node from "@astrojs/node";
import vercel from "@astrojs/vercel/serverless";
import { defineConfig } from "astro/config";

const isDockerBuild = process.env.NEARZERO_DOCKER_BUILD === "1";

export default defineConfig({
	output: "server",
	adapter: isDockerBuild ? node({ mode: "standalone" }) : vercel(),
	integrations: [tailwind(), react()],
	// Prefetch linked pages on hover so client-side (View Transitions) navigation
	// feels instant — the destination HTML is usually already cached by the time
	// the user clicks. `hover` only fetches on intent, so it stays lightweight.
	prefetch: {
		prefetchAll: true,
		defaultStrategy: "hover",
	},
	server: { port: 4321, host: true },
	vite: {
		resolve: {
			alias: {
				"@": new URL("./src", import.meta.url).pathname,
				"@nearzero/styles": new URL("./src/styles", import.meta.url).pathname,
				"@nearzero/spec": new URL(
					"./src/lib/nearzero-spec-stub.ts",
					import.meta.url,
				).pathname,
			},
		},
		server: {
			proxy: {
				"/drawer-logs": {
					target: "http://127.0.0.1:3000",
					ws: true,
					changeOrigin: true,
				},
				"/listen-deployment": {
					target: "http://127.0.0.1:3000",
					ws: true,
					changeOrigin: true,
				},
				"/docker-container-logs": {
					target: "http://127.0.0.1:3000",
					ws: true,
					changeOrigin: true,
				},
				"/docker-container-terminal": {
					target: "http://127.0.0.1:3000",
					ws: true,
					changeOrigin: true,
				},
				"/terminal": {
					target: "http://127.0.0.1:3000",
					ws: true,
					changeOrigin: true,
				},
				"/listen-docker-stats-monitoring": {
					target: "http://127.0.0.1:3000",
					ws: true,
					changeOrigin: true,
				},
			},
		},
		optimizeDeps: {
			include: [
				"@trpc/client",
				"@xterm/xterm",
				"@xterm/addon-attach",
				"xterm-addon-fit",
			],
		},
		ssr: {
			noExternal: [],
			external: ["@nearzero/server"],
		},
	},
});
