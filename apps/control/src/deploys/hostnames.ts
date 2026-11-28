/**
 * Where a deploy gets its hostnames (spec 6.5, 10): modules register hostname providers at
 * startup (the domains area does, in createServices). Before routing a deploy the pipeline asks
 * each one, in the order they registered, with the service, its server and its port; the routes
 * they answer are written through the routing module (pointing at the new container), and their
 * notes go into the deploy log as plain lines. With no provider, or no routes, the app deploys
 * with no hostname and the log says so.
 */

export interface HostnameRequest {
  serviceId: string;
  /** The server's id, or "host" for the Nearzero host. */
  serverId: string;
  /** The container port traffic should reach (the service port). */
  port: number;
}

export interface HostnameRoute {
  host: string;
  path: string;
  port: number;
  /** For Compose services: which service of the stack the route reaches. */
  composeService?: string;
  https: boolean;
}

export interface HostnameAnswer {
  routes: HostnameRoute[];
  /** Plain lines for the deploy log, like "… won't load until this DNS record exists …". */
  notes: string[];
  /**
   * Lines that need a DNS lookup first (spec 6.5, 10.2). The deploy never waits for them: they
   * are written to the log when they arrive, which may be after the deploy finished.
   */
  later?: Promise<string[]>;
}

export type HostnameProvider = (request: HostnameRequest) => Promise<HostnameAnswer>;

export class HostnameProviders {
  readonly #providers: { name: string; provide: HostnameProvider }[] = [];

  /** Adds a provider; a second one with the same name replaces the first. */
  register(name: string, provide: HostnameProvider): void {
    const index = this.#providers.findIndex((item) => item.name === name);
    if (index >= 0) this.#providers[index] = { name, provide };
    else this.#providers.push({ name, provide });
  }

  get size(): number {
    return this.#providers.length;
  }

  /**
   * Every provider's answer, together. A provider that fails adds a note naming it instead of
   * failing the deploy: the app still runs, at the hostnames the others gave.
   */
  async collect(request: HostnameRequest): Promise<HostnameAnswer & { failed: string[] }> {
    const routes: HostnameRoute[] = [];
    const notes: string[] = [];
    const failed: string[] = [];
    const later: Promise<string[]>[] = [];
    for (const provider of this.#providers) {
      try {
        const answer = await provider.provide(request);
        routes.push(...answer.routes);
        notes.push(...answer.notes);
        if (answer.later) later.push(answer.later.catch(() => []));
      } catch (error) {
        failed.push(provider.name);
        notes.push(
          `Couldn't get this service's hostnames from ${provider.name}: ${(error as Error).message || "no reason given"}. Deploy again to retry.`,
        );
      }
    }
    // One route per hostname and path; the first provider to name it wins.
    const seen = new Set<string>();
    const unique = routes.filter((route) => {
      const key = `${route.host.toLowerCase()}${route.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return {
      routes: unique,
      notes,
      failed,
      later: Promise.all(later).then((groups) => groups.flat()),
    };
  }
}

/** Registers a provider on the control plane's registry (for modules that only hold services). */
export function registerHostnameProvider(
  services: { hostnameProviders: HostnameProviders },
  name: string,
  provide: HostnameProvider,
): void {
  services.hostnameProviders.register(name, provide);
}
