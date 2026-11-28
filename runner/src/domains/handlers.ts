import type { DomainCommandKind, ParsedCommandParams } from "@nearzero/shared";
import type { CommandContext } from "../commands.ts";
import { domainsFor } from "./runtime.ts";

/**
 * The runner's handlers for certificate and DNS commands (spec 10.7, 10.8). commands.ts adds
 * them to its table.
 */

type Handler<K extends DomainCommandKind> = (
  params: ParsedCommandParams<K>,
  context: CommandContext,
) => Promise<unknown>;

function runtime(context: CommandContext) {
  const found = domainsFor(context.router);
  if (!found)
    throw new Error("Certificates and DNS aren't set up in this runner. Update the runner.");
  return found;
}

export const domainHandlers: { [K in DomainCommandKind]: Handler<K> } = {
  "certificates.status": async (_params, context) => runtime(context).status(),
  "certificates.retry": async (params, context) => runtime(context).retry(params.hostname),
  "certificates.contact": async (params, context) => runtime(context).setContact(params.email),
  "certificates.uploads": async (params, context) =>
    runtime(context).setUploads(params.certificates),
  "dns.apply": async (params, context) => runtime(context).dns.apply(params.corefile, params.zones),
  "dns.status": async (params, context) => runtime(context).dns.status(params.zones),
};
