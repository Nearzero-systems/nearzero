import { mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { $ } from "bun";
import { interpreterLibc } from "./libc.ts";

/**
 * Compiles the runner into one self-contained binary per server architecture (spec 25, D5),
 * then writes SHA256SUMS beside them so downloads can be checked.
 *
 * x64 uses Bun's baseline build, which runs on CPUs without AVX2 (older and budget servers).
 *
 * The musl builds are for Alpine-based servers (spec 23.6). They link the system's C++ runtime,
 * so server setup on Alpine installs it first: apk add libstdc++ libgcc
 */

const root = resolve(import.meta.dir, "..");
const outDir = join(root, "dist");
const entry = join(root, "src", "main.ts");

const targets = [
  { target: "bun-linux-x64-baseline", file: "nearzero-runner-linux-x64", libc: "glibc" },
  { target: "bun-linux-arm64", file: "nearzero-runner-linux-arm64", libc: "glibc" },
  { target: "bun-linux-x64-musl-baseline", file: "nearzero-runner-linux-x64-musl", libc: "musl" },
  { target: "bun-linux-arm64-musl", file: "nearzero-runner-linux-arm64-musl", libc: "musl" },
] as const;

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const sums: string[] = [];
for (const { target, file, libc } of targets) {
  const outfile = join(outDir, file);
  console.log(`Building ${file} (${target})`);
  await $`bun build ${entry} --compile --target=${target} --outfile=${outfile}`.quiet();
  const found = interpreterLibc(
    new Uint8Array(await Bun.file(outfile).slice(0, 65536).arrayBuffer()),
  );
  if (found !== libc) {
    throw new Error(
      `${file} was built for ${found ?? "an unknown C library"}, not ${libc}. Build the runners on a glibc host (Debian, Ubuntu or macOS), not Alpine.`,
    );
  }
  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(outfile).arrayBuffer())
    .digest("hex");
  sums.push(`${digest}  ${basename(outfile)}`);
}

await Bun.write(join(outDir, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`Wrote ${targets.length} binaries and SHA256SUMS to ${outDir}`);
