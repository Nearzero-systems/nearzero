/**
 * Backups and restores as a list of steps (spec 17.2, 23.1). Each step is one program with its
 * arguments, run on its own with standard input closed, so no step can read the steps after it
 * the way a script fed to a shell on standard input can. Every step's exit status is checked
 * before the next one starts; the first failure stops the list and names the step. Steps marked
 * `always` (starting a stopped service again) run even after a failure, and their own failure
 * is reported too.
 */

export interface Step {
  /** What the step does, in the log's words: "Dumping the database". */
  title: string;
  /** The program and its arguments, never a shell line. */
  argv: string[];
  /** Runs even when an earlier step failed (and doesn't stop the ones after it). */
  always?: boolean;
  /** Exit codes that count as success (default: only 0). */
  okExitCodes?: number[];
}

export interface StepResult {
  exitCode: number | null;
  /** What the program wrote to standard output (when the launcher captures it). */
  stdout: string;
}

/** Runs one step somewhere: a helper container, or (in tests) a local process. */
export type StepLauncher<S extends Step = Step> = (step: S, index: number) => Promise<StepResult>;

export class StepFailure extends Error {
  readonly step: string;
  readonly exitCode: number | null;
  constructor(step: string, exitCode: number | null, detail?: string) {
    super(
      detail ??
        `${step} failed (exit code ${exitCode === null ? "none: it was stopped" : exitCode}).`,
    );
    this.name = "StepFailure";
    this.step = step;
    this.exitCode = exitCode;
  }
}

export interface StepsOutcome {
  results: (StepResult | null)[];
  /** The first failure, if any; later `always` steps still ran. */
  failure: StepFailure | null;
}

/**
 * Runs the steps in order. Returns every step's result (null for steps skipped after a failure)
 * and the first failure. Never throws for a failed step; a launcher that throws counts as that
 * step failing with the launcher's message.
 */
export async function runSteps<S extends Step>(
  steps: readonly S[],
  launch: StepLauncher<S>,
  out: (text: string) => void,
): Promise<StepsOutcome> {
  const results: (StepResult | null)[] = [];
  let failure: StepFailure | null = null;
  for (const [index, step] of steps.entries()) {
    if (failure && !step.always) {
      results.push(null);
      continue;
    }
    out(`→ ${step.title}\n`);
    let result: StepResult;
    try {
      result = await launch(step, index);
    } catch (error) {
      const problem = new StepFailure(
        step.title,
        null,
        `${step.title} failed: ${(error as Error)?.message ?? String(error)}`,
      );
      out(`✗ ${problem.message}\n`);
      failure ??= problem;
      results.push(null);
      continue;
    }
    results.push(result);
    const ok = (step.okExitCodes ?? [0]).includes(result.exitCode ?? -1);
    if (!ok) {
      const problem = new StepFailure(step.title, result.exitCode);
      out(`✗ ${problem.message}\n`);
      failure ??= problem;
      continue;
    }
    out(`✓ ${step.title}\n`);
  }
  return { results, failure };
}
