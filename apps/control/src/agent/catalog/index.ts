import type { AnyCapability } from "../capability.ts";
import { appCapabilities } from "./apps.ts";
import { deployCapabilities } from "./deploys.ts";
import { projectCapabilities } from "./projects.ts";
import { researchFileCapabilities } from "./research-files.ts";
import { serverCapabilities } from "./servers.ts";
import { readServiceCapability } from "./service-read.ts";
import { moreServiceCapabilities } from "./services-more.ts";
import { taskCapabilities } from "./tasks.ts";

/**
 * The Agent's capability catalog (spec 20), one module per area. Every row of spec 20 is here;
 * rows whose module isn't finished answer that they aren't available yet (see `pending`).
 */
const CATALOG: readonly AnyCapability[] = [
  ...projectCapabilities,
  ...appCapabilities,
  readServiceCapability,
  ...moreServiceCapabilities,
  ...deployCapabilities,
  ...serverCapabilities,
  ...taskCapabilities,
  ...researchFileCapabilities,
];

export function capabilityCatalog(): readonly AnyCapability[] {
  return CATALOG;
}
