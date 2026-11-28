import { embed, PATHS, readSources } from "./files.ts";

/**
 * Copies installer/compose.yml and installer/nearzero into install.sh, which carries them so the
 * published installer is a single checksummed file.
 *
 *   bun installer/scripts/embed.ts           update install.sh
 *   bun installer/scripts/embed.ts --check   fail when install.sh is out of date
 */

const check = process.argv.includes("--check");
const current = await Bun.file(PATHS.install).text();
const updated = embed(current, await readSources());

if (updated === current) {
  process.stdout.write(
    "install.sh already carries the current compose file and nearzero command.\n",
  );
} else if (check) {
  console.error(
    "install.sh carries an old copy of compose.yml or nearzero. Run: bun installer/scripts/embed.ts",
  );
  process.exit(1);
} else {
  await Bun.write(PATHS.install, updated);
  process.stdout.write("Updated install.sh with the current compose file and nearzero command.\n");
}
