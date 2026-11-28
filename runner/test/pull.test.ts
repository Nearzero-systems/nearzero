import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { commandParamsSchemas } from "@nearzero/shared";
import { retryTiming } from "../src/builds/transient.ts";
import { type CommandContext, handlerFor } from "../src/commands.ts";
import { DockerError } from "../src/docker/client.ts";

/**
 * Pulling an image for a deploy (spec 6.5, 30b R2-01, R2-08): a registry that answers 503 for a
 * moment is tried again with a line in the log, a real refusal fails at once, and the ports the
 * image declares come back for the service port.
 */

beforeAll(() => {
  retryTiming.scale = 0;
});

afterAll(() => {
  retryTiming.scale = 1;
});

function context(pull: () => Promise<void>, exposed: string[] = []) {
  const lines: string[] = [];
  let pulls = 0;
  const docker = {
    pullImage: async () => {
      pulls++;
      await pull();
    },
    imageExists: async () => true,
    imageExposedPorts: async () => exposed,
    removeImage: async () => {},
  };
  const ctx = {
    docker,
    signal: new AbortController().signal,
    stream: { text: (text: string) => lines.push(text) },
  } as unknown as CommandContext;
  return { ctx, lines, pulls: () => pulls };
}

const params = () => commandParamsSchemas["image.pull"].parse({ image: "nginx:alpine" });

describe("image pulls (R2-08, R2-01)", () => {
  test("a 503 once, then the pull works: the deploy goes on and the log notes the retry", async () => {
    let failures = 1;
    const { ctx, lines, pulls } = context(async () => {
      if (failures-- > 0) {
        throw new DockerError(
          500,
          'Get "https://registry-1.docker.io/v2/": received unexpected HTTP status: 503 Service Unavailable',
        );
      }
    }, ["80/tcp"]);
    const result = await handlerFor("image.pull")(params(), ctx);
    expect(result).toEqual({ image: "nginx:alpine", exposedPorts: ["80/tcp"] });
    expect(pulls()).toBe(2);
    expect(lines.join("")).toContain(
      "It looks like a passing network or registry problem; trying again in 2 seconds (attempt 2 of 3).",
    );
  });

  test("an image that doesn't exist fails at once", async () => {
    const { ctx, pulls } = context(async () => {
      throw new DockerError(404, "pull access denied for acme/missing, repository does not exist");
    });
    await expect(handlerFor("image.pull")(params(), ctx)).rejects.toThrow("pull access denied");
    expect(pulls()).toBe(1);
  });

  test("a registry that keeps failing gives up after three tries", async () => {
    const { ctx, pulls } = context(async () => {
      throw new DockerError(500, "toomanyrequests: Too Many Requests");
    });
    await expect(handlerFor("image.pull")(params(), ctx)).rejects.toThrow("Too Many Requests");
    expect(pulls()).toBe(3);
  });
});
