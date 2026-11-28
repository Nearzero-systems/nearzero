import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { editionLabels, NEARZERO_LABELS } from "@nearzero/shared";
import { runCommand } from "../exec/command.ts";

/**
 * Making images Nearzero's own (spec 3.3: uninstall and teardown find everything Nearzero
 * created by its label). Docker can't label an image it pulled, so a copy is made under
 * Nearzero's name with the labels added: the same layers, a new name. When the pulled tag
 * wasn't on the server before, it is dropped again, so the labelled copy is the only name left.
 * Built images get the same treatment when their builder left the labels off.
 */

export interface OwnImageContext {
  env: Record<string, string>;
  /** Scratch space for the (empty) build context. */
  workDirectory: string;
  signal: AbortSignal;
  out: (text: string) => void;
}

async function docker(context: OwnImageContext, args: string[], timeoutMs = 60_000) {
  return runCommand({
    argv: ["docker", ...args],
    env: context.env,
    timeoutMs,
    signal: context.signal,
  });
}

/** The labels every image the runner makes or keeps carries: the caller's and the managed one. */
export function ownLabels(labels: Record<string, string>): Record<string, string> {
  return { ...labels, [NEARZERO_LABELS.managed]: "true", ...editionLabels() };
}

/** Builds `FROM image` with the labels, tagged with every one of `tags`. */
async function copyWithLabels(
  context: OwnImageContext,
  image: string,
  tags: readonly string[],
  labels: Record<string, string>,
): Promise<void> {
  const scratch = join(context.workDirectory, "own-image", crypto.randomUUID());
  await mkdir(scratch, { recursive: true });
  try {
    // Docker's own builder, which finds `image` in the server's image store.
    const argv = [
      "docker",
      "buildx",
      "build",
      "--builder",
      "default",
      "--progress=quiet",
      "--load",
    ];
    for (const tag of tags) argv.push("--tag", tag);
    argv.push("--file", "-");
    for (const [key, value] of Object.entries(ownLabels(labels))) {
      argv.push("--label", `${key}=${value}`);
    }
    argv.push(scratch);
    const result = await runCommand({
      argv,
      stdin: `FROM ${image}\n`,
      env: context.env,
      timeoutMs: 10 * 60_000,
      signal: context.signal,
    });
    if (result.exitCode !== 0) {
      context.out(result.output);
      throw new Error(
        `Couldn't label ${image} as Nearzero's (exit code ${result.exitCode ?? "none"}).`,
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Tags `image` (already pulled) as `tag` with the labels and Nearzero's managed label. */
export async function labelledCopy(
  context: OwnImageContext,
  image: string,
  tag: string,
  labels: Record<string, string>,
): Promise<void> {
  await copyWithLabels(context, image, [tag], labels);
  context.out(`Tagged ${image} as ${tag}\n`);
}

interface ImageDetails {
  id: string;
  labels: Record<string, string>;
}

/** An image's id and labels, or null when the server has no image by that name. */
async function inspectImage(
  context: OwnImageContext,
  reference: string,
): Promise<ImageDetails | null> {
  const result = await docker(context, [
    "image",
    "inspect",
    "--format",
    '{{.Id}}{{"\\n"}}{{json .Config.Labels}}',
    reference,
  ]);
  if (result.exitCode !== 0) return null;
  const [id, labels] = result.output.trim().split("\n");
  if (!id) return null;
  try {
    return {
      id: id.trim(),
      labels: (JSON.parse(labels ?? "null") as ImageDetails["labels"]) ?? {},
    };
  } catch {
    return null;
  }
}

/**
 * Makes sure a built image carries the labels and Nearzero's managed label under every one of
 * its tags. Not every builder can set labels (Railpack's BuildKit frontend ignores them, and
 * buildpacks have no option for them), so an image without them gets a labelled copy under the
 * same tags, and the unlabelled original, which then has no name, is removed. Returns true when
 * a copy was made.
 */
export async function ensureLabelled(
  context: OwnImageContext,
  tags: readonly string[],
  labels: Record<string, string>,
): Promise<boolean> {
  const [first] = tags;
  if (!first) throw new Error("There's no image to label.");
  const built = await inspectImage(context, first);
  if (!built) throw new Error(`The build didn't leave an image named ${first}.`);
  const wanted = ownLabels(labels);
  if (Object.entries(wanted).every(([key, value]) => built.labels[key] === value)) return false;
  await copyWithLabels(context, first, tags, labels);
  const copy = await inspectImage(context, first);
  if (!copy || Object.entries(wanted).some(([key, value]) => copy.labels[key] !== value)) {
    throw new Error(`Couldn't label ${first} as Nearzero's.`);
  }
  if (copy.id !== built.id) await docker(context, ["image", "rm", built.id]);
  context.out(`Added Nearzero's labels to ${first}\n`);
  return true;
}

/** Pulls `image` with the Docker CLI, makes the labelled copy, and drops a tag it added. */
export async function pullAsOwn(
  context: OwnImageContext,
  image: string,
  tag: string,
  labels: Record<string, string>,
): Promise<void> {
  const existed = (await docker(context, ["image", "inspect", image])).exitCode === 0;
  if (!existed) {
    context.out(`Pulling ${image}\n`);
    const pulled = await docker(context, ["pull", "--quiet", image], 30 * 60_000);
    if (pulled.exitCode !== 0) {
      context.out(pulled.output);
      throw new Error(`Pulling ${image} failed.`);
    }
  }
  await labelledCopy(context, image, tag, labels);
  if (!existed) await docker(context, ["image", "rm", image]);
}
