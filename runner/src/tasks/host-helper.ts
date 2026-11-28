import { NEARZERO_LABELS, TASK_RUN_MARKER } from "@nearzero/shared";

const PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * The helper container a host task runs in: the runner's own image, entering the host's
 * namespaces with nsenter, as root (the image's own user can't, B2-03). Pure, so it is tested.
 */
export function hostHelperConfig(
  image: string,
  spec: { runId: string; shell: string; flags: string[]; script: string },
): Record<string, unknown> {
  return {
    Image: image,
    Entrypoint: ["nsenter"],
    Cmd: [
      "-t",
      "1",
      "-m",
      "-u",
      "-i",
      "-n",
      "-p",
      "-r",
      // From root's home folder, as spec 30's decisions say host tasks run (R3-28).
      "-w/root",
      "--",
      spec.shell,
      ...spec.flags,
      "-c",
      spec.script,
    ],
    Env: [`${TASK_RUN_MARKER}=${spec.runId}`, `PATH=${PATH}`, "HOME=/root", "LANG=C.UTF-8"],
    // The runner's image runs as an unprivileged user; nsenter into the host's namespaces needs
    // root even in a privileged container (B2-03).
    User: "0:0",
    Labels: { [NEARZERO_LABELS.managed]: "true", "dev.nearzero.task-run": spec.runId },
    Tty: false,
    OpenStdin: false,
    AttachStdin: false,
    HostConfig: {
      Privileged: true,
      PidMode: "host",
      NetworkMode: "host",
      IpcMode: "host",
      UTSMode: "host",
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "1" } },
    },
  };
}
