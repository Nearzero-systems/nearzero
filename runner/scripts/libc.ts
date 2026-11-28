/**
 * The C library a Linux binary's program interpreter belongs to (its PT_INTERP path, near the
 * start of the file), from the binary's first bytes. Compiling on an Alpine host has been seen
 * to give glibc targets musl's interpreter, which can't start on glibc servers, so the build
 * checks every binary with this.
 */
export function interpreterLibc(head: Uint8Array): "glibc" | "musl" | null {
  const text = Buffer.from(head).toString("latin1");
  if (/\/ld-musl-[a-z0-9_]+\.so/.test(text)) return "musl";
  if (/\/ld-linux[a-z0-9_-]*\.so/.test(text)) return "glibc";
  return null;
}
