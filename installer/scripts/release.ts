import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  checksumLine,
  embed,
  INSTALLER_DIR,
  PATHS,
  productVersion,
  readSources,
  sha256,
  stamp,
} from "./files.ts";

/**
 * Lays out the installer files for one release (spec 03 3.1 "versioned address", 23.3):
 *
 *   <out>/install.sh  install.sh.sha256  uninstall.sh  uninstall.sh.sha256       latest
 *   <out>/v<version>/install.sh  ...                                             pinned
 *
 * Each .sha256 file reads `<hex>  <name>`, so `sha256sum -c install.sh.sha256` checks it.
 * This only writes files; publishing them is the release workflow's job.
 *
 *   bun installer/scripts/release.ts [--version 1.0.0]
 *                                    [--image-repository ghcr.io/nearzero-systems/nearzero]
 *                                    [--out installer/dist/release]
 */

const DEFAULT_REPOSITORY = "ghcr.io/nearzero-systems/nearzero";

export interface ReleaseFile {
  path: string;
  content: string;
}

/** Every file of a release, with paths relative to the output folder. */
export function releaseFiles(input: {
  version: string;
  imageRepository: string;
  installText: string;
  uninstallText: string;
}): ReleaseFile[] {
  const install = stamp(input.installText, input.version, input.imageRepository);
  const files: ReleaseFile[] = [];
  for (const prefix of ["", `v${input.version}/`]) {
    files.push(
      { path: `${prefix}install.sh`, content: install },
      { path: `${prefix}install.sh.sha256`, content: checksumLine("install.sh", install) },
      { path: `${prefix}uninstall.sh`, content: input.uninstallText },
      {
        path: `${prefix}uninstall.sh.sha256`,
        content: checksumLine("uninstall.sh", input.uninstallText),
      },
    );
  }
  return files;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      "image-repository": { type: "string" },
      out: { type: "string" },
    },
  });
  const version = values.version ?? (await productVersion());
  const imageRepository = values["image-repository"] ?? DEFAULT_REPOSITORY;
  const out = resolve(values.out ?? join(INSTALLER_DIR, "dist", "release"));

  const source = await Bun.file(PATHS.install).text();
  const installText = embed(source, await readSources());
  if (installText !== source) {
    throw new Error(
      "install.sh carries an old copy of compose.yml or nearzero. Run: bun installer/scripts/embed.ts",
    );
  }
  const files = releaseFiles({
    version,
    imageRepository,
    installText,
    uninstallText: await Bun.file(PATHS.uninstall).text(),
  });

  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, `v${version}`), { recursive: true });
  for (const file of files) await Bun.write(join(out, file.path), file.content);

  // Read everything back and check each checksum against the file beside it.
  for (const file of files.filter((f) => f.path.endsWith(".sha256"))) {
    const [hex, name] = (await Bun.file(join(out, file.path)).text()).trim().split(/\s+/);
    const target = join(out, file.path.replace(/[^/]*$/, ""), name ?? "");
    if (sha256(await Bun.file(target).text()) !== hex) {
      throw new Error(`${file.path} doesn't match ${name}.`);
    }
  }
  process.stdout.write(`Wrote the ${version} installer files to ${out}\n`);
  for (const file of files) process.stdout.write(`  ${file.path}\n`);
}

if (import.meta.main) await main();
