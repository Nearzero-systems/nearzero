import { fileURLToPath } from "node:url";
import node from "@astrojs/node";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import type { AstroIntegration } from "astro";
import { defineConfig, passthroughImageService } from "astro/config";
import { attachSocketBridge } from "./src/lib/socket-bridge.ts";

/**
 * Pages for people building the console (the living style guide at /dev/components). They are
 * routed only by `astro dev`, so production builds never contain them.
 */
function developmentPages(): AstroIntegration {
  return {
    name: "nearzero:development-pages",
    hooks: {
      "astro:config:setup": ({ command, injectRoute }) => {
        if (command !== "dev") return;
        injectRoute({
          pattern: "/dev/components",
          entrypoint: new URL("./src/dev/components.astro", import.meta.url),
        });
      },
    },
  };
}

/**
 * Terminals reach the control plane over WebSockets through the console (spec 6.7;
 * src/lib/socket-bridge.ts). The dev server gets the bridge from its own hook. The production
 * server is the Node adapter's standalone one, which offers no hook for upgrades, so the build
 * adds one call right after it creates its HTTP server; the build stops if that spot moved.
 */
/** Bun's marker for JavaScript it should run without transpiling it again. */
const BUN_READY = "// @bun";

const BRIDGE = fileURLToPath(new URL("./src/lib/socket-bridge.ts", import.meta.url));
const SERVER_CREATED = "enableDestroy(httpServer);";

function terminalSockets(): AstroIntegration {
  return {
    name: "nearzero:terminal-sockets",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        updateConfig({
          vite: {
            plugins: [
              {
                name: "nearzero:standalone-upgrades",
                enforce: "pre",
                transform(code, id) {
                  if (!id.replaceAll("\\", "/").includes("@astrojs/node/dist/standalone.js"))
                    return;
                  if (!code.includes(SERVER_CREATED)) {
                    this.error(
                      "The Node adapter's standalone server changed; terminals need their WebSocket hook placed again (astro.config.ts).",
                    );
                  }
                  return `import { attachSocketBridge as nearzeroSockets } from ${JSON.stringify(BRIDGE)};\n${code.replace(
                    SERVER_CREATED,
                    `${SERVER_CREATED}\n\tnearzeroSockets(httpServer);`,
                  )}`;
                },
              },
            ],
          },
        });
      },
      "astro:server:setup": ({ server }) => {
        attachSocketBridge(server.httpServer as Parameters<typeof attachSocketBridge>[0]);
      },
    },
  };
}

/**
 * The production image carries no node_modules (Dockerfile), so the built server must be
 * self-contained: every package it imports at run time (React for the Agent page, marked,
 * Astro's own runtime) is bundled into dist/server instead of being left as a bare import; only
 * Node's built-in modules stay external. Only `astro build` does this: the dev server loads
 * packages from disk as usual (bundling CommonJS packages there fails).
 *
 * Every server file then starts with Bun's `// @bun` marker, which says the file is plain,
 * already-built JavaScript (ASCII only, as Bun reads it as Latin-1), so Bun runs it as is
 * instead of transpiling it again at load time.
 * Bun 1.3's load-time transpiler mishandles labeled statements in React's production server
 * renderer (it refuses one file outright, and in others drops the `else` branch after a labeled
 * block that breaks out through `finally`, so rendering never finishes).
 */
function selfContainedServer(): AstroIntegration {
  return {
    name: "nearzero:self-contained-server",
    hooks: {
      "astro:config:setup": ({ command, updateConfig }) => {
        if (command !== "build") return;
        updateConfig({
          vite: {
            ssr: { noExternal: true },
            // Bun reads `// @bun` files as Latin-1, so they must be plain ASCII: non-ASCII
            // characters (an ellipsis, an arrow, an accented name) are written as \u escapes.
            build: { rolldownOptions: { output: { charset: "ascii" } } },
            plugins: [
              {
                name: "nearzero:bun-ready-server",
                applyToEnvironment: (environment) => environment.config.consumer === "server",
                renderChunk(code) {
                  // The bundler escapes non-ASCII in strings; what it leaves (template literal
                  // text, comments) is escaped here. Templates are read cooked (Astro reads the
                  // parts, never `.raw`), so \u escapes there keep the same text.
                  const ascii = code.replace(
                    /[\u0080-￿]/g,
                    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
                  );
                  return { code: `${BUN_READY}\n${ascii}`, map: null };
                },
              },
            ],
          },
        });
      },
    },
  };
}

// The console renders on the server (spec 25, D5). The standalone Node adapter runs under Bun.
// In production it listens on PORT (4321 by default); `bun run dev` passes 4400.
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  // No image processing: keeps Astro's optional sharp/libvips (LGPL) out of the running console.
  image: { service: passthroughImageService() },
  // The console prefetches on hover, press and focus itself, with the rules of spec 21.7.
  prefetch: false,
  devToolbar: { enabled: false },
  // React only for the highly interactive parts: the Agent chat (spec 25, D5).
  integrations: [developmentPages(), terminalSockets(), selfContainedServer(), react()],
  vite: {
    plugins: [tailwindcss()],
    // The browser sweep writes screenshots while the dev server runs; they are not sources.
    server: { watch: { ignored: ["**/test-artifacts/**"] } },
  },
});
