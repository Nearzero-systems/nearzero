import type { APIRoute } from "astro";
import { connectionOf, crossSiteResponse, forwardToControl } from "../../../lib/control-api.ts";
import { refusedAsCrossSite } from "../../../lib/origin-check.ts";

// Every /api/v1 request from the browser goes to the control plane, with the console's own
// account of who the browser is (X-Forwarded-For and X-Forwarded-Proto). Changes sent from a page
// on another site are refused here (spec 22.4, 24 G11).
export const ALL: APIRoute = (context) => {
  let peer: string | undefined;
  try {
    peer = context.clientAddress;
  } catch {
    // The adapter couldn't tell; the control plane then sees no client address.
  }
  if (refusedAsCrossSite(context.request, peer)) return crossSiteResponse(context.request);
  return forwardToControl(context.request, connectionOf(context.request, peer), {
    originChecked: true,
  });
};
