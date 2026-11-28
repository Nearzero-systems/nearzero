import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * What the automatic builder decides from the files (spec 6.1, 6.4): a Dockerfile at the build
 * path wins; otherwise a known framework goes to Railpack and anything else to Nixpacks. The
 * detected framework is also what the project canvas shows as "Framework".
 */

export interface Detection {
  /** A Dockerfile at the build path (its file name), or null. */
  dockerfile: string | null;
  /** A detected framework, like "Next.js", or null. */
  framework: string | null;
  /** The language the files are in, when one is recognized. */
  language: string | null;
}

const DOCKERFILE_NAMES = ["Dockerfile", "dockerfile", "Containerfile"];

/** Dependencies that name a framework, in the order they are checked. */
const NODE_FRAMEWORKS: [string, string][] = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@remix-run/node", "Remix"],
  ["@react-router/dev", "React Router"],
  ["@sveltejs/kit", "SvelteKit"],
  ["astro", "Astro"],
  ["@angular/core", "Angular"],
  ["@nestjs/core", "NestJS"],
  ["gatsby", "Gatsby"],
  ["vite", "Vite"],
  ["react-scripts", "Create React App"],
  ["@vue/cli-service", "Vue"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["hono", "Hono"],
  ["koa", "Koa"],
];

const PYTHON_FRAMEWORKS: [RegExp, string][] = [
  [/^django\b/im, "Django"],
  [/^flask\b/im, "Flask"],
  [/^fastapi\b/im, "FastAPI"],
  [/^streamlit\b/im, "Streamlit"],
];

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

async function text(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch(() => null);
}

export async function findDockerfile(folder: string): Promise<string | null> {
  for (const name of DOCKERFILE_NAMES) {
    const path = join(folder, name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile()) return name;
  }
  return null;
}

export async function detect(folder: string): Promise<Detection> {
  const dockerfile = await findDockerfile(folder);
  const packageJson = await text(join(folder, "package.json"));
  if (packageJson !== null) {
    let dependencies: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(packageJson) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      dependencies = { ...parsed.devDependencies, ...parsed.dependencies };
    } catch {
      // A broken package.json is the builder's to report.
    }
    const found = NODE_FRAMEWORKS.find(([name]) => name in dependencies);
    const language =
      (await exists(join(folder, "bun.lock"))) || (await exists(join(folder, "bun.lockb")))
        ? "Bun"
        : "Node.js";
    return { dockerfile, framework: found?.[1] ?? null, language };
  }
  const requirements =
    (await text(join(folder, "requirements.txt"))) ?? (await text(join(folder, "pyproject.toml")));
  if (requirements !== null || (await exists(join(folder, "Pipfile")))) {
    const found = PYTHON_FRAMEWORKS.find(([pattern]) => pattern.test(requirements ?? ""));
    return { dockerfile, framework: found?.[1] ?? null, language: "Python" };
  }
  const gemfile = await text(join(folder, "Gemfile"));
  if (gemfile !== null) {
    return {
      dockerfile,
      framework: /gem\s+["']rails["']/.test(gemfile) ? "Rails" : null,
      language: "Ruby",
    };
  }
  const composer = await text(join(folder, "composer.json"));
  if (composer !== null) {
    return {
      dockerfile,
      framework: composer.includes("laravel/framework") ? "Laravel" : null,
      language: "PHP",
    };
  }
  if (await exists(join(folder, "go.mod"))) return { dockerfile, framework: null, language: "Go" };
  if (await exists(join(folder, "Cargo.toml"))) {
    return { dockerfile, framework: null, language: "Rust" };
  }
  if ((await exists(join(folder, "pom.xml"))) || (await exists(join(folder, "build.gradle")))) {
    return { dockerfile, framework: null, language: "Java" };
  }
  if (await exists(join(folder, "mix.exs"))) {
    return {
      dockerfile,
      framework: (await text(join(folder, "mix.exs")))?.includes(":phoenix") ? "Phoenix" : null,
      language: "Elixir",
    };
  }
  if (await exists(join(folder, "index.html"))) {
    return { dockerfile, framework: null, language: "Static" };
  }
  return { dockerfile, framework: null, language: null };
}

/** Automatic mode's choice: Dockerfile, else Railpack for a known framework, else Nixpacks. */
export function automaticBuilder(detection: Detection): "dockerfile" | "railpack" | "nixpacks" {
  if (detection.dockerfile) return "dockerfile";
  return detection.framework ? "railpack" : "nixpacks";
}
