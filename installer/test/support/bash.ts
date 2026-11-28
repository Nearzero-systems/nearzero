import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BashOptions {
  env: Record<string, string | undefined>;
  /** Standard input; Bun's default when left out. */
  stdin?: "ignore" | Blob;
}

export interface BashResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs bash on a program given as text: how the installer tests run install.sh's, the
 * uninstaller's and the nearzero command's functions with stand-ins added.
 *
 * The program goes through a file, never `bash -c <text>`: Linux refuses any one argument over
 * 128 KiB (MAX_ARG_STRLEN, so spawning fails with E2BIG), and install.sh alone is larger. macOS
 * only limits all arguments together, so `bash -c` with the whole installer worked there and
 * failed on every Linux machine. A file, unlike `bash -s`, also leaves standard input to the test.
 */
export async function runBash(program: string, options: BashOptions): Promise<BashResult> {
  const folder = await mkdtemp(join(tmpdir(), "nz1-bash-"));
  try {
    const file = join(folder, "program.sh");
    await writeFile(file, program);
    const child = Bun.spawn(["bash", file], {
      env: options.env,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, stdout, stderr };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
