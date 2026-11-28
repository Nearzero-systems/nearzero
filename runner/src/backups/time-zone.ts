import { readFile, readlink } from "node:fs/promises";

/**
 * The server's time zone, which backup schedules use (spec 08 8.3: "times are in the server's
 * time zone"). TZ, when set for the runner, wins: the Nearzero host's runner runs in a container
 * that can't see the host's files, so the installer reads the host's zone name and compose.yml
 * passes it as TZ. A runner on the server itself reads /etc/timezone or the /etc/localtime link.
 * Only when no name is known does it take the offset of the Docker Engine's clock. The answer is
 * an IANA name, or (last resort, blind to daylight saving) a fixed offset like UTC+05:30.
 */

/** "UTC+05:30" from the offset at the end of an RFC 3339 time, or null. */
export function offsetZone(rfc3339: string): string | null {
  const match = /([+-])(\d{2}):?(\d{2})$/.exec(rfc3339.trim());
  if (!match) return /Z$/i.test(rfc3339.trim()) ? "UTC" : null;
  if (match[2] === "00" && match[3] === "00") return "UTC";
  return `UTC${match[1]}${match[2]}:${match[3]}`;
}

/**
 * Whether a name looks like an IANA zone ("Europe/Berlin", "UTC"). The runner doesn't check it
 * against a zone database (a small Linux image may have none); the control plane does, and
 * uses UTC for a name it doesn't know.
 */
export function looksLikeZone(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(name) && name.length <= 64;
}

export function zoneFromLink(target: string): string | null {
  const at = target.indexOf("zoneinfo/");
  if (at < 0) return null;
  const zone = target.slice(at + "zoneinfo/".length).replace(/^(posix|right)\//, "");
  return zone && looksLikeZone(zone) ? zone : null;
}

export async function serverTimeZone(
  engineTime: string | null,
  containerized: boolean,
): Promise<string> {
  // TZ set for the runner wins everywhere (an operator can set it on the host's runner too).
  const fromEnv = process.env.TZ?.replace(/^:/, "");
  if (fromEnv && looksLikeZone(fromEnv)) return fromEnv;
  if (containerized) return (engineTime && offsetZone(engineTime)) || "UTC";
  const file = (await readFile("/etc/timezone", "utf8").catch(() => "")).trim();
  if (file && looksLikeZone(file)) return file;
  const link = await readlink("/etc/localtime").catch(() => "");
  const linked = link ? zoneFromLink(link) : null;
  if (linked) return linked;
  return (engineTime && offsetZone(engineTime)) || "UTC";
}
