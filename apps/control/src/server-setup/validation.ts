import {
  formatBytes,
  missingVerdict,
  reportedAsVerdict,
  SERVER_READINESS_LABELS,
  type ServerReadiness,
  VALIDATION_VERDICTS,
  type ValidationCheckView,
  type ValidationView,
} from "@nearzero/shared";
import { TOOL_RELEASES } from "../../../../runner/tools/pins.ts";
import type { ControlServices } from "../services.ts";
import { keyValues } from "./parse.ts";
import { remoteCommand, validationScript } from "./scripts.ts";
import type { SshSession } from "./ssh.ts";

/**
 * Setup validation (spec 09 9.4): each check as ready, not ready or a version, the mandatory ones
 * deciding the verdict. It reads the server over SSH (read-only) and asks the runner's link
 * whether the runner is connected (spec 25 D1). The newest result is kept for the details.
 */

export interface ValidationInputs {
  serverId: string;
  user: string;
  session: SshSession;
  sudo: boolean;
  readiness: ServerReadiness | null;
}

function check(
  id: string,
  label: string,
  mandatory: boolean,
  state: ValidationCheckView["state"],
  value: string | null,
): ValidationCheckView {
  return { id, label, mandatory, state, value };
}

/** Builds the checks from the validation script's answer and the runner's link. */
export function checksFrom(
  output: string,
  input: {
    user: string;
    sudoWorks: boolean;
    runner: { online: boolean; version: string | null };
    metricsRecently: boolean;
  },
): ValidationCheckView[] {
  const values = keyValues(output);
  const get = (key: string) => values.get(key) ?? "";
  const checks: ValidationCheckView[] = [];

  const docker = get("docker_version");
  const compose = get("compose_version");
  const buildx = get("buildx_version");
  if (!docker) checks.push(check("docker", "Docker", true, "not_ready", "Docker isn't answering"));
  else if (!compose || !buildx) {
    checks.push(
      check(
        "docker",
        "Docker",
        true,
        "not_ready",
        `${docker}, without the ${!compose ? "Compose" : "buildx"} plugin`,
      ),
    );
  } else {
    checks.push(
      check(
        "docker",
        "Docker",
        true,
        "version",
        `${docker} (Compose ${compose.replace(/^v/, "")}, buildx ${buildx.replace(/^v/, "")})`,
      ),
    );
  }

  const missingFolders = get("folders_missing").trim();
  checks.push(
    missingFolders
      ? check(
          "folders",
          "Nearzero's folders",
          true,
          "not_ready",
          `Missing: ${missingFolders.split(/\s+/).join(", ")}`,
        )
      : check("folders", "Nearzero's folders", true, "ready", null),
  );

  const tools: string[] = [];
  const missingTools: string[] = [];
  for (const release of TOOL_RELEASES) {
    const key = `tool_${release.tool}_${release.version.replace(/\W/g, "_")}`;
    if (get(key)) tools.push(`${release.tool} ${release.version}`);
    else missingTools.push(`${release.tool} ${release.version}`);
  }
  checks.push(
    missingTools.length > 0
      ? check("builders", "Builders", true, "not_ready", `Missing: ${missingTools.join(", ")}`)
      : check("builders", "Builders", true, "version", tools.join(", ")),
  );

  const rclone = get("rclone_version");
  checks.push(
    rclone
      ? check("rclone", "rclone", true, "version", rclone.replace(/^v/, ""))
      : check("rclone", "rclone", true, "not_ready", "Not installed"),
  );

  const security = get("docker_security");
  if (!docker)
    checks.push(check("runtime", "Container runtime", true, "not_ready", "Docker isn't answering"));
  else if (/rootless/.test(security)) {
    checks.push(check("runtime", "Container runtime", true, "not_ready", "Docker runs rootless"));
  } else {
    const swarm = get("swarm") === "active" ? " (Swarm is also active)" : "";
    checks.push(check("runtime", "Container runtime", true, "ready", `Docker Engine${swarm}`));
  }

  if (input.user === "root") {
    checks.push(check("sudo", "Passwordless sudo", true, "ready", "Signed in as root"));
  } else {
    checks.push(
      input.sudoWorks
        ? check("sudo", "Passwordless sudo", true, "ready", null)
        : check(
            "sudo",
            "Passwordless sudo",
            true,
            "not_ready",
            `${input.user} can't use sudo without a password`,
          ),
    );
    checks.push(
      get("docker_group") === "yes"
        ? check("docker_group", "Docker group", true, "ready", `${input.user} is a member`)
        : check("docker_group", "Docker group", true, "not_ready", `${input.user} isn't a member`),
    );
  }

  checks.push(
    get("network")
      ? check("network", "Private network", true, "ready", get("network"))
      : check("network", "Private network", true, "not_ready", "Missing"),
  );

  const [running, , image] = get("router").split("|");
  const owner = get("router_dir_owner");
  checks.push(
    running === "true"
      ? check(
          "router",
          "Router",
          true,
          "ready",
          `Running as ${owner || "its folder's owner"}${image ? ` (${image})` : ""}`,
        )
      : check("router", "Router", true, "not_ready", "Not running"),
  );

  checks.push(
    input.runner.online
      ? check(
          "runner",
          "Runner",
          true,
          "ready",
          `Connected${input.runner.version ? ` (${input.runner.version})` : ""}`,
        )
      : check(
          "runner",
          "Runner",
          true,
          "not_ready",
          get("runner_installed") === "yes" ? "Installed, not connected" : "Not installed",
        ),
  );

  const swapKb = Number(get("swap_kb") || 0);
  checks.push(
    swapKb > 0
      ? check("swap", "Swap", false, "ready", formatBytes(swapKb * 1024))
      : check("swap", "Swap", false, "not_ready", "None"),
  );
  checks.push(
    input.metricsRecently
      ? check("monitoring", "Monitoring", false, "ready", "CPU, memory and disk every 5 seconds")
      : check("monitoring", "Monitoring", false, "not_ready", "No metrics yet"),
  );
  return checks;
}

/** The verdict sentence (spec 9.4). */
export function verdictOf(
  checks: ValidationCheckView[],
  readiness: ServerReadiness | null,
  reason: string | null,
): { ok: boolean; verdict: string } {
  const mandatory = checks.filter((item) => item.mandatory);
  if (mandatory.some((item) => item.state === "unknown")) {
    return { ok: false, verdict: VALIDATION_VERDICTS.unconfirmed };
  }
  const missing = mandatory.filter((item) => item.state === "not_ready").map((item) => item.label);
  if (missing.length > 0) return { ok: false, verdict: missingVerdict(missing) };
  if (readiness && readiness !== "ready" && readiness !== "setup_running") {
    return {
      ok: true,
      verdict: reportedAsVerdict(
        SERVER_READINESS_LABELS[readiness],
        reason ?? "setup hasn't finished",
      ),
    };
  }
  return { ok: true, verdict: VALIDATION_VERDICTS.ready };
}

export function unconfirmedValidation(error: string): ValidationView {
  return {
    checkedAt: new Date().toISOString(),
    checks: [],
    ok: false,
    verdict: `${VALIDATION_VERDICTS.unconfirmed} ${error}`.trim(),
  };
}

async function metricsSince(services: ControlServices, serverId: string, sinceMs: number) {
  const row = await services.db
    .selectFrom("server_metric")
    .select("at")
    .where("target", "=", serverId)
    .where("at", ">=", new Date(sinceMs))
    .limit(1)
    .executeTakeFirst();
  return Boolean(row);
}

export async function validateServer(
  services: ControlServices,
  input: ValidationInputs,
  reason: string | null = null,
): Promise<ValidationView> {
  const result = await input.session.exec(remoteCommand({ shell: "bash", sudo: input.sudo }), {
    stdin: validationScript({ user: input.user, builders: TOOL_RELEASES }),
    timeoutMs: 120_000,
  });
  let sudoWorks = input.user === "root";
  if (!sudoWorks) {
    const sudo = await input.session.exec("sudo -n true", { timeoutMs: 30_000 }).catch(() => null);
    sudoWorks = sudo?.code === 0;
  }
  const connection = services.runners.connection(input.serverId);
  const checks = checksFrom(result.stdout, {
    user: input.user,
    sudoWorks,
    runner: { online: connection !== null, version: connection?.runnerVersion ?? null },
    metricsRecently: await metricsSince(services, input.serverId, Date.now() - 60_000),
  });
  const { ok, verdict } = verdictOf(checks, input.readiness, reason);
  const view: ValidationView = { checkedAt: new Date().toISOString(), checks, ok, verdict };
  await storeValidation(services, input.serverId, view);
  return view;
}

export async function storeValidation(
  services: ControlServices,
  serverId: string,
  view: ValidationView,
): Promise<void> {
  await services.db
    .insertInto("server_inspection")
    .values({ server_id: serverId, validation: JSON.stringify(view), validation_at: new Date() })
    .onConflict((conflict) =>
      conflict
        .column("server_id")
        .doUpdateSet({ validation: JSON.stringify(view), validation_at: new Date() }),
    )
    .execute();
}

export async function storedValidation(
  services: ControlServices,
  serverId: string,
): Promise<ValidationView | null> {
  const row = await services.db
    .selectFrom("server_inspection")
    .select("validation")
    .where("server_id", "=", serverId)
    .executeTakeFirst();
  const value = row?.validation as ValidationView | null | undefined;
  return value && Array.isArray(value.checks) ? value : null;
}
