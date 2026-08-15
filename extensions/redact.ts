/**
 * Secret-safe validation and redaction (env-contracts 5.3, fleet-cockpit
 * context hygiene, incident-artifacts redaction). Literal credential-like
 * values are replaced with `[REDACTED]` and never reach prompts, observability,
 * registries, or artifacts. Allowed `${UPPER_SNAKE_CASE}` placeholders and
 * connection-profile identifiers are not credentials.
 */

export interface SecretHit {
  line: number;
  column: number;
  category: string;
  redacted: string;
}

const PLACEHOLDER_RE = /^\$\{[A-Z][A-Z0-9_]*\}$/;
const PROFILE_RE = /^[a-z][a-z0-9-]{1,64}$/;

const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const AUTH_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_ASSIGN_RE = /(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const URI_USERINFO_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+):([^@/\s]+)@/g;

/** True when a value is an allowed `${UPPER_SNAKE_CASE}` placeholder. */
export function isAllowedValue(value: string): boolean {
  const v = String(value).trim();
  if (v.length === 0) return true; // empty assignment is not a secret
  return PLACEHOLDER_RE.test(v);
}

/** Connection-profile identifiers are allowed only for the `connectionProfile` key. */
export function isProfileIdentifier(value: string): boolean {
  return PROFILE_RE.test(String(value).trim());
}

function stripQuotes(v: string): string {
  return v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
    ? v.slice(1, -1)
    : v;
}

/** 1-based line/column of a match index. */
function positionOf(text: string, index: number, matchLen: number): SecretHit {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = index - (lastNewline + 1);
  void matchLen;
  return { line, column, category: "unknown", redacted: "[REDACTED]" };
}

export type SecretCategory = "private-key-block" | "authorization-header" | "credential-key" | "uri-userinfo" | "password-assignment";

/**
 * Find secret-like literals in text with file-style line/column diagnostics.
 * Only categories and redacted placeholders are reported — never values.
 */
export function findSecretHits(text: string): Array<SecretHit & { category: SecretCategory }> {
  const hits: Array<SecretHit & { category: SecretCategory }> = [];

  let m: RegExpExecArray | null;
  PRIVATE_KEY_RE.lastIndex = 0;
  while ((m = PRIVATE_KEY_RE.exec(text)) !== null) {
    const pos = positionOf(text, m.index, m[0].length);
    hits.push({ ...pos, category: "private-key-block" });
  }
  AUTH_RE.lastIndex = 0;
  while ((m = AUTH_RE.exec(text)) !== null) {
    // The whole token is redacted including the scheme word for a header;
    // ignore if followed by a placeholder (allowed identifiers only appear after "=" / ":").
    const hit = positionOf(text, m.index, m[0].length);
    hits.push({ ...hit, category: "authorization-header" });
  }
  KEY_ASSIGN_RE.lastIndex = 0;
  while ((m = KEY_ASSIGN_RE.exec(text)) !== null) {
    const value = stripQuotes(m[2] ?? "");
    if (isAllowedValue(value)) continue;
    const key = (m[1] ?? "").toLowerCase();
    const cat: SecretCategory =
      key === "password" || key === "passwd" ? "password-assignment" : "credential-key";
    const hit = positionOf(text, m.index, m[0].length);
    hits.push({ ...hit, category: cat });
  }
  URI_USERINFO_RE.lastIndex = 0;
  while ((m = URI_USERINFO_RE.exec(text)) !== null) {
    const hit = positionOf(text, m.index, m[0].length);
    hits.push({ ...hit, category: "uri-userinfo" });
  }
  return hits.sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Replace credential-like values with `[REDACTED]`. Returns the redacted text
 * and the number of replacements. Placeholders/identifiers are left intact.
 */
export function redactSensitive(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;

  out = out.replace(PRIVATE_KEY_RE, () => {
    count++;
    return "[REDACTED:private-key]";
  });

  out = out.replace(AUTH_RE, (match, scheme: string) => {
    count++;
    return `${scheme} [REDACTED]`;
  });

  out = out.replace(KEY_ASSIGN_RE, (match, key: string, rawValue: string) => {
    const value = stripQuotes(rawValue);
    if (isAllowedValue(value)) return match;
    count++;
    return `${match.slice(0, match.indexOf(rawValue))}[REDACTED]`;
  });

  out = out.replace(URI_USERINFO_RE, (_match, prefix: string, _pw: string) => {
    count++;
    const at = _match.indexOf("@");
    return `${prefix}:[REDACTED]${_match.slice(at)}`;
  });

  return { text: out, count };
}

// helper: keep the regex used by redact/scan in sync
const URI_USER_RE = URI_USERINFO_RE;