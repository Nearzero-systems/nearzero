import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { runCommand } from "../exec/command.ts";
import { writeFileAtomically } from "../router/files.ts";

/**
 * Images the runner pulls for builds that can't carry Nearzero's label (spec 3.3): `pack` uses
 * the buildpacks' builder image and the run image it names by their own names, and a labelled
 * copy under the same name would change what pack runs. So the ones the runner brought onto the
 * server are recorded instead, one reference per line in `pulled-images` in its work folder;
 * images that were on the server before are never recorded. The uninstaller removes what is
 * listed there (from the runner's state volume on the Nearzero host) unless a container uses it.
 */

export const PULLED_IMAGES_FILE = "pulled-images";

/** Adds references to the record, keeping each once. */
export async function recordPulledImages(file: string, references: readonly string[]) {
  const wanted = references.filter((reference) => /^[^\s]+$/.test(reference));
  if (wanted.length === 0) return;
  const known = (await readFile(file, "utf8").catch(() => ""))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const next = [...new Set([...known, ...wanted])];
  if (next.length === known.length) return;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomically(file, `${next.join("\n")}\n`, 0o600);
}

/**
 * The run images a buildpacks builder names in its metadata label: `runImages` (newer
 * builders) or `stack.runImage` (older ones), with their mirrors.
 */
export function runImagesOf(labels: Record<string, string> | null): string[] {
  const raw = labels?.["io.buildpacks.builder.metadata"];
  if (!raw) return [];
  let metadata: {
    runImages?: { image?: unknown; mirrors?: unknown }[];
    stack?: { runImage?: { image?: unknown; mirrors?: unknown } };
  };
  try {
    metadata = JSON.parse(raw);
  } catch {
    return [];
  }
  const entries = [...(metadata.runImages ?? []), metadata.stack?.runImage ?? {}];
  const out: string[] = [];
  for (const entry of entries) {
    if (typeof entry.image === "string") out.push(entry.image);
  }
  return [...new Set(out)];
}

export interface ImageCheckContext {
  env: Record<string, string>;
  signal: AbortSignal;
}

/** An image's labels, or null when the server doesn't have it. */
export async function localImageLabels(
  context: ImageCheckContext,
  reference: string,
): Promise<Record<string, string> | null> {
  const result = await runCommand({
    argv: ["docker", "image", "inspect", "--format", "{{json .Config.Labels}}", reference],
    env: context.env,
    timeoutMs: 60_000,
    signal: context.signal,
  });
  if (result.exitCode !== 0) return null;
  try {
    return (JSON.parse(result.output.trim() || "null") as Record<string, string> | null) ?? {};
  } catch {
    return {};
  }
}
