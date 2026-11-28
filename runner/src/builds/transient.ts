/**
 * Failures worth another try (spec 23.1, 30b R2-08): fetching a source, pulling an image or
 * building can fail for a moment because of the network or a busy registry. Those are tried up to
 * three times, a few seconds apart, with a line in the log; real errors (a compile error, a
 * missing branch, a refused login) fail at once.
 */

export const MAX_ATTEMPTS = 3;

const TRANSIENT = [
  /i\/o timeout/i,
  /TLS handshake timeout/i,
  /(connection|operation|network|socket|read|request) timed? ?out/i,
  /context deadline exceeded/i,
  /unexpected EOF/i,
  /early EOF/i,
  /connection reset( by peer)?/i,
  /broken pipe/i,
  /socket hang up/i,
  /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ESOCKETTIMEDOUT)\b/,
  /too many requests/i,
  /(status|code|HTTP\/[\d.]+|returned error|response)[ :]+(408|425|429|500|502|503|504)\b/i,
  /\b(429|500|502|503|504) (Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)/i,
  /Service Unavailable/i,
  /Temporary failure in name resolution/i,
  /the remote end hung up unexpectedly/i,
  /RPC failed/i,
  /kex_exchange_identification|Connection closed by remote host|ssh_exchange_identification/i,
];

/** Whether an error message or the end of a program's output looks like a passing problem. */
export function looksTransient(text: string): boolean {
  const tail = text.split("\n").slice(-60).join("\n");
  return TRANSIENT.some((pattern) => pattern.test(tail));
}

/** Seconds before attempt `next` (2, then 5). */
export function retryDelaySeconds(next: number): number {
  return next <= 2 ? 2 : 5;
}

/** "trying again in 2 seconds (attempt 2 of 3)". */
export function retryWords(next: number): string {
  return `trying again in ${retryDelaySeconds(next)} seconds (attempt ${next} of ${MAX_ATTEMPTS})`;
}

/** Tests shorten the pauses; nothing else changes it. */
export const retryTiming = { scale: 1 };

export async function pause(seconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(done, seconds * 1000 * retryTiming.scale);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });
}
