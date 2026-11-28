import type { PortMapping } from "@nearzero/shared";

/**
 * Which container port an app's traffic goes to (spec 6.1, 6.5, 6.9, 30b R2-01). A port the
 * person typed always wins. Otherwise, in order: the first TCP container port of the app's own
 * port mappings; the TCP ports its image declares (EXPOSE), preferring the usual web ports; 80
 * for the Static builder's server; else 3000. The deploy log says which one and why.
 */

/** The ports picked first when an image declares several, in this order. */
export const PREFERRED_PORTS = [80, 3000, 8080, 8000, 5000, 4173] as const;

export const DEFAULT_SERVICE_PORT = 3000;

export interface ServicePortChoice {
  port: number;
  why: string;
}

/** "8080/tcp" (or "8080") to 8080; UDP and anything else to null. */
function tcpPort(declared: string): number | null {
  const [number, protocol = "tcp"] = declared.split("/");
  if (protocol !== "tcp") return null;
  const port = Number(number);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

export function chooseServicePort(input: {
  /** The port the person typed, or null when they didn't. */
  typed: number | null;
  mappings: readonly PortMapping[];
  /** What the image declares; null when it wasn't read (a Reload: the image is the same). */
  exposed: readonly string[] | null;
  builder: string;
  /** The port found at the last deploy, used when the image wasn't read. */
  previous: number;
}): ServicePortChoice {
  if (input.typed !== null) {
    return { port: input.typed, why: "the service port set in Settings" };
  }
  const mapped = input.mappings.find((mapping) => mapping.protocol === "tcp");
  if (mapped) return { port: mapped.containerPort, why: "the app's first published port" };
  if (input.exposed === null) {
    return { port: input.previous, why: "the port found at the last deploy" };
  }
  const declared = [
    ...new Set(input.exposed.map(tcpPort).filter((port): port is number => port !== null)),
  ];
  if (declared.length > 0) {
    const preferred = PREFERRED_PORTS.find((port) => declared.includes(port));
    const port = preferred ?? Math.min(...declared);
    const list = declared
      .sort((a, b) => a - b)
      .map((item) => `${item}/tcp`)
      .join(", ");
    return {
      port,
      why:
        declared.length === 1
          ? `the image declares ${list}`
          : preferred
            ? `the image declares ${list}, and ${port} is the usual web port among them`
            : `the image declares ${list}, so the lowest`,
    };
  }
  if (input.builder === "static") return { port: 80, why: "the Static builder's server" };
  return {
    port: DEFAULT_SERVICE_PORT,
    why: "the image declares no port, so the default; set one in Settings if the app listens elsewhere",
  };
}
