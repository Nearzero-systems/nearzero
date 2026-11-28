import { z } from "zod";

/**
 * Runner commands for certificates and the built-in DNS server (spec 10.7, 10.8). They are part
 * of the runner protocol (runner-protocol.ts spreads them into its command list) and were added
 * as new command kinds, so older runners answer them with "unsupported".
 */

const hostname = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/);

const zoneName = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);

/** An uploaded certificate's id on the runner (its file names). */
const uploadId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);

export const domainCommandSchemas = {
  /**
   * The router's certificates (names and validity only, never keys), what the runner knows
   * about recent Let's Encrypt attempts, and its holds.
   */
  "certificates.status": z.object({}),
  /** Lets one hostname ask Let's Encrypt again after the control plane allowed a Retry. */
  "certificates.retry": z.object({ hostname }),
  /**
   * The contact email the router gives Let's Encrypt for new certificates: the one saved under
   * About Nearzero (spec 10.1, 10.9). Saved by the runner; a change recreates the router.
   */
  "certificates.contact": z.object({ email: z.string().trim().max(254) }),
  /** Makes the router hold exactly these uploaded certificates (and use them for their names). */
  "certificates.uploads": z.object({
    certificates: z
      .array(
        z.object({
          id: uploadId,
          certificatePem: z.string().min(1).max(65_536),
          keyPem: z.string().min(1).max(65_536),
        }),
      )
      .max(500),
  }),
  /**
   * Writes the built-in DNS server's configuration and zone files and keeps the server running,
   * or stops it when there are no zones (spec 03 3.1: it runs only with a managed zone).
   */
  "dns.apply": z.object({
    corefile: z.string().max(1_000_000),
    zones: z.array(z.object({ name: zoneName, content: z.string().max(4_000_000) })).max(500),
  }),
  /** Whether the built-in DNS server runs, and the SOA serial it answers for each zone. */
  "dns.status": z.object({ zones: z.array(zoneName).max(500).default([]) }),
} as const;

export type DomainCommandKind = keyof typeof domainCommandSchemas;

/** One certificate in the router's store, as `certificates.status` reports it. */
export const storedCertificateSchema = z.object({
  names: z.array(z.string()),
  notBefore: z.number(),
  notAfter: z.number(),
  issuer: z.string(),
});
export type StoredCertificate = z.infer<typeof storedCertificateSchema>;

/** What the runner knows about one hostname's Let's Encrypt attempts. */
export const attemptRecordSchema = z.object({
  hostname: z.string(),
  /** Failed validations, which count toward the pause (R3-18). */
  failures: z.array(z.number()),
  lastError: z.string().nullable(),
  /** When the last error happened, counted or not (added in 1.0, R3-18). */
  lastErrorAt: z.number().nullable().optional(),
  rateLimitedUntil: z.number().nullable(),
  requestedAt: z.number().nullable(),
  retriedAt: z.number().nullable(),
});
export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

export const certificateStatusSchema = z.object({
  readable: z.boolean(),
  error: z.string().nullable(),
  certificates: z.array(storedCertificateSchema),
  uploaded: z.array(z.object({ id: z.string(), names: z.array(z.string()), notAfter: z.number() })),
  attempts: z.array(attemptRecordSchema),
  holds: z.array(z.object({ hostname: z.string(), reason: z.string() })),
  /** Hostnames held by the back-off (paused or rate limited). */
  backoff: z.array(z.string()),
  checkedAt: z.number(),
});
export type CertificateStatus = z.infer<typeof certificateStatusSchema>;

export const dnsStatusSchema = z.object({
  running: z.boolean(),
  error: z.string().nullable(),
  zones: z.array(z.object({ name: z.string(), serial: z.number().nullable() })),
});
export type DnsStatus = z.infer<typeof dnsStatusSchema>;
