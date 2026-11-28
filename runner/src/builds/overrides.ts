/**
 * Builder image overrides from the runner's environment (spec 03 3.5, the settings 0.1.x had):
 * NEARZERO_HEROKU_BUILDER_IMAGE, NEARZERO_PAKETO_BUILDER_IMAGE, NEARZERO_RAILPACK_FRONTEND_IMAGE
 * and NEARZERO_STATIC_NGINX_IMAGE. Each must be pinned by digest, as the runner's own pins are;
 * anything else is ignored (the installer refuses it before it gets here).
 */

const PINNED = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;

export interface BuilderOverrides {
  heroku: string | null;
  paketo: string | null;
  railpackFrontend: string | null;
  staticServer: string | null;
}

function pinned(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return PINNED.test(trimmed) ? trimmed : null;
}

export function builderOverrides(env: Record<string, string | undefined>): BuilderOverrides {
  return {
    heroku: pinned(env.NEARZERO_HEROKU_BUILDER_IMAGE),
    paketo: pinned(env.NEARZERO_PAKETO_BUILDER_IMAGE),
    railpackFrontend: pinned(env.NEARZERO_RAILPACK_FRONTEND_IMAGE),
    staticServer: pinned(env.NEARZERO_STATIC_NGINX_IMAGE),
  };
}

/** This runner's overrides, read once when it starts. */
export const BUILDER_OVERRIDES: BuilderOverrides = builderOverrides(process.env);
