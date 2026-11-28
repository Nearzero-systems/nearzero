import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

/**
 * Helpers shared by the embed and release scripts. The installer is published as one file, so the
 * compose file and the `nearzero` command travel inside it as quoted here-documents; their
 * sources stay separate files in this folder (spec 03 3.1, 23.3).
 */

export const INSTALLER_DIR = resolve(import.meta.dir, "..");
export const REPO_ROOT = resolve(INSTALLER_DIR, "..");

export const PATHS = {
  install: join(INSTALLER_DIR, "install.sh"),
  uninstall: join(INSTALLER_DIR, "uninstall.sh"),
  compose: join(INSTALLER_DIR, "compose.yml"),
  command: join(INSTALLER_DIR, "nearzero"),
  version: join(REPO_ROOT, "packages", "shared", "src", "version.ts"),
} as const;

/** Here-document delimiters in install.sh, one per embedded file. */
export const EMBEDS = [
  { delimiter: "NEARZERO_EMBEDDED_COMPOSE", source: "compose" },
  { delimiter: "NEARZERO_EMBEDDED_COMMAND", source: "command" },
] as const;

export type EmbedSource = (typeof EMBEDS)[number]["source"];

function blockPattern(delimiter: string): RegExp {
  return new RegExp(`(<<'${delimiter}'\\n)([\\s\\S]*?)(^${delimiter}$)`, "m");
}

/** The text currently embedded under a delimiter, or null when the block is missing. */
export function readEmbedded(installText: string, delimiter: string): string | null {
  const match = blockPattern(delimiter).exec(installText);
  return match ? (match[2] ?? "") : null;
}

/** Puts each source file's text inside its here-document. */
export function embed(installText: string, sources: Record<EmbedSource, string>): string {
  let text = installText;
  for (const { delimiter, source } of EMBEDS) {
    const content = sources[source];
    if (content.split("\n").includes(delimiter)) {
      throw new Error(`${source} contains a line "${delimiter}", which would end its block early.`);
    }
    const body = content.endsWith("\n") ? content : `${content}\n`;
    if (readEmbedded(text, delimiter) === null) {
      throw new Error(`install.sh has no here-document named ${delimiter}.`);
    }
    text = text.replace(blockPattern(delimiter), (_all, open: string, _old, close: string) => {
      return `${open}${body}${close}`;
    });
  }
  return text;
}

export async function readSources(): Promise<Record<EmbedSource, string>> {
  return {
    compose: await Bun.file(PATHS.compose).text(),
    command: await Bun.file(PATHS.command).text(),
  };
}

/** The product version from packages/shared, the one source of truth for every component. */
export async function productVersion(): Promise<string> {
  const text = await Bun.file(PATHS.version).text();
  const match = /export const VERSION = "([^"]+)"/.exec(text);
  if (!match?.[1]) throw new Error(`No VERSION constant in ${PATHS.version}.`);
  return match[1];
}

/** Sets the release constants at the top of install.sh. */
export function stamp(installText: string, version: string, imageRepository: string): string {
  const versionLine = /^NZ_VERSION="[^"]*"$/m;
  const repositoryLine = /^NZ_IMAGE_REPOSITORY="[^"]*"$/m;
  if (!versionLine.test(installText) || !repositoryLine.test(installText)) {
    throw new Error("install.sh lost its NZ_VERSION or NZ_IMAGE_REPOSITORY line.");
  }
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`"${version}" isn't a release version like 1.0.0 or 1.0.0-rc.1.`);
  }
  if (!/^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)+$/.test(imageRepository)) {
    throw new Error(
      `"${imageRepository}" isn't an image repository like ghcr.io/nearzero-systems/nearzero.`,
    );
  }
  return installText
    .replace(versionLine, `NZ_VERSION="${version}"`)
    .replace(repositoryLine, `NZ_IMAGE_REPOSITORY="${imageRepository}"`);
}

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** A checksum file in the format `sha256sum -c` reads. */
export function checksumLine(fileName: string, content: string | Uint8Array): string {
  return `${sha256(content)}  ${fileName}\n`;
}
