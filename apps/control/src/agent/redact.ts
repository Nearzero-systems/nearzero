/**
 * What the model may read (spec 19.11, 23.4): variable values, build arguments and secrets,
 * database passwords, tokens, keys and Compose file contents are removed from every result; Git
 * URLs keep their host and path without credentials. Inputs that look like they carry a secret
 * are refused before anything runs.
 */

const SECRET_KEYS =
  /^(value|values|password|rootpassword|passwd|secret|secrets|token|tokens|accesstoken|refreshtoken|apikey|api_key|privatekey|private_key|clientsecret|webhooksecret|composefile|content|contents|buildargs|buildsecrets|env|environmentvalues|credentials|authorization|cookie|key|sealed|secrets_sealed|connectionurl|url_with_password)$/i;

/** Keys that look secret but hold harmless flags or names. */
const KEEP_KEYS = /^(passwordset|hassecret|secretsset|keyid|sshkeyid|keyname|configured)$/i;

const TOKEN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-or-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g,
  /\bfc-[A-Za-z0-9]{16,}/g,
  /\bre_[A-Za-z0-9_]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bnzw1\.[A-Za-z0-9._-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** Credentials inside URLs: scheme://user:pass@host → scheme://host. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;

export function redactText(text: string): string {
  let out = text.replace(URL_CREDENTIALS, "$1");
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

/** A deep copy with secret fields removed and secret-looking strings masked. */
export function redactForModel(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 12) return "[…]";
  if (Array.isArray(value)) return value.map((item) => redactForModel(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (!KEEP_KEYS.test(key) && SECRET_KEYS.test(key)) {
      if (inner === null || inner === undefined || inner === "") out[key] = inner;
      else out[key] = "[hidden]";
      continue;
    }
    out[key] = redactForModel(inner, depth + 1);
  }
  return out;
}

const SECRET_ASSIGNMENT =
  /\b[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Z0-9_]*\s*=\s*['"]?[^\s'"$]{3,}/i;
const SECRET_FLAG = /--(password|token|secret|api-key)[= ]\s*['"]?[^\s'"$]{3,}/i;

/**
 * Refusal words for a command, script or text the model wants to save, when it looks like it
 * carries a secret (spec 20.3): assignments to TOKEN, SECRET, PASSWORD, API_KEY…, provider key
 * formats, private-key headers. null when it looks clean.
 */
export function secretLookingInput(text: string): string | null {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    return "This looks like it contains a private key, so it was refused. Keys go through the SSH key form.";
  }
  if (TOKEN_PATTERNS.slice(1).some((pattern) => new RegExp(pattern.source).test(text))) {
    return "This looks like it contains an API key or token, so it was refused. Put secrets in the service's variables through the variables form.";
  }
  if (SECRET_ASSIGNMENT.test(text) || SECRET_FLAG.test(text)) {
    return "This looks like it sets a password, token or key, so it was refused. Put secrets in the service's variables through the variables form and refer to them by name.";
  }
  return null;
}
