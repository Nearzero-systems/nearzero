/**
 * What happens instead of service settings 1.0 dropped (spec 27, 29a.7), for the report lines the
 * importer writes when a record uses one (spec 29.5, "Dry run first").
 */

export const DROPPED_SERVICE_SETTINGS: Record<string, string> = {
  redirects: "Redirects aren't in Nearzero 1.0, so requests reach the app as they arrive.",
  basicAuth: "Basic auth isn't in Nearzero 1.0, so the app is served without it.",
  replicas: "Replica counts aren't in Nearzero 1.0, so it runs one container.",
  resourceLimits: "Resource limits aren't in Nearzero 1.0, so it runs without them.",
  healthCheck:
    "Health check settings aren't in Nearzero 1.0; a deploy waits for the container to keep running instead.",
  command:
    "Custom commands aren't in Nearzero 1.0, so it starts with its Start command or its image's own.",
  args: "Custom arguments aren't in Nearzero 1.0, so it starts with its image's own.",
  buildArgs:
    "Build arguments aren't in Nearzero 1.0; its variables are available while it builds instead.",
  buildSecrets:
    "Build secrets aren't in Nearzero 1.0; its variables are available while it builds instead.",
  routerConfig:
    "Its own router configuration isn't in Nearzero 1.0, so it is routed by its hostnames.",
  placement: "Placement rules aren't in Nearzero 1.0, so it runs on its server.",
  previews: "Preview deployments aren't in Nearzero 1.0, so pull requests aren't deployed.",
  rollbacks: "Rollbacks aren't in Nearzero 1.0; deploy an earlier commit instead.",
  registry:
    "Container registries aren't in Nearzero 1.0; an image from a private registry uses the login saved on the app.",
  databaseCommand:
    "Custom database start commands aren't in Nearzero 1.0, so it starts with the default.",
  composeBackups:
    "Compose database backups aren't in Nearzero 1.0; back up the stack's volumes instead.",
};
