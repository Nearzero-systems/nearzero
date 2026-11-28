import { isLegacyHash, verifyLegacyPassword } from "./legacy-passwords.ts";

/**
 * Password hashing with argon2id (spec 25, D5), through Bun's built-in implementation.
 *
 * Checking a password for an email that has no account still runs one full verification against
 * a stand-in hash made with the same settings, so both answers take the same time (spec 04 4.1).
 */

export interface PasswordHashingOptions {
  /** Memory in KiB. */
  memoryCost: number;
  /** Passes over memory. */
  timeCost: number;
}

/** Production settings: 64 MiB and 3 passes. */
export const PRODUCTION_HASHING: PasswordHashingOptions = { memoryCost: 65_536, timeCost: 3 };

/** Much cheaper settings for tests only. */
export const TEST_HASHING: PasswordHashingOptions = { memoryCost: 1024, timeCost: 1 };

export class PasswordHasher {
  #standIn: Promise<string> | undefined;

  constructor(readonly options: PasswordHashingOptions = PRODUCTION_HASHING) {}

  hash(password: string): Promise<string> {
    return Bun.password.hash(password, { algorithm: "argon2id", ...this.options });
  }

  /** True when the password matches. A malformed stored hash counts as no match. */
  async verify(password: string, storedHash: string | null): Promise<boolean> {
    if (storedHash === null) {
      await this.verifyStandIn(password);
      return false;
    }
    // A hash carried over from 0.1.x (spec 29.5); sign-in replaces it after a match.
    if (isLegacyHash(storedHash)) return verifyLegacyPassword(password, storedHash);
    try {
      return await Bun.password.verify(password, storedHash);
    } catch {
      return false;
    }
  }

  /** True when a stored hash should be replaced by a fresh argon2id hash after a match. */
  needsRehash(storedHash: string | null): boolean {
    return isLegacyHash(storedHash);
  }

  /** Spends the same effort as a real check, for accounts that don't exist. */
  async verifyStandIn(password: string): Promise<void> {
    this.#standIn ??= this.hash(crypto.randomUUID());
    try {
      await Bun.password.verify(password, await this.#standIn);
    } catch {
      // The outcome is never used.
    }
  }
}
