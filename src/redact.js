"use strict";

const os = require("node:os");

const PLACEHOLDER = "[redacted]";

/**
 * Default redaction patterns.
 *
 * Stack traces and error messages routinely carry connection strings, JWTs,
 * `?token=` query params and provider API keys. Auto-posting those to a public
 * repository is an incident, so redaction is on by default and runs before
 * anything leaves the process.
 *
 * Order matters: broader, structural patterns (private keys, connection
 * strings) run before the narrower ones so a secret is never partially masked.
 */
const DEFAULT_PATTERNS = [
  // PEM private key blocks.
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  // JSON Web Tokens.
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
  },
  // Credentials embedded in a URL: scheme://user:pass@host
  {
    name: "connection-string",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi,
    replace: (_match, scheme, user) => `${scheme}${user}:${PLACEHOLDER}@`,
  },
  // Authorization headers.
  {
    name: "bearer",
    pattern: /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_match, scheme) => `${scheme} ${PLACEHOLDER}`,
  },
  // GitHub personal access / app tokens.
  {
    name: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  // OpenAI and Anthropic style keys.
  {
    name: "provider-key",
    pattern: /\b(?:sk|pk)-(?:[A-Za-z0-9_-]+-)?[A-Za-z0-9_-]{16,}\b/g,
  },
  // Slack tokens.
  { name: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // AWS access key IDs.
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/g },
  // Secret-ish query parameters.
  {
    name: "query-secret",
    pattern:
      /([?&](?:access_token|api[_-]?key|apikey|auth|key|password|pwd|secret|signature|sig|token)=)([^&\s"'`]+)/gi,
    replace: (_match, prefix) => `${prefix}${PLACEHOLDER}`,
  },
  // Assignments such as password=..., "api_key": "...", token: '...'
  {
    name: "assigned-secret",
    pattern:
      /(["'`]?)\b(passwd|password|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|token)\b\1(\s*[:=]\s*)(["'`]?)([^\s"'`,;)}\]]+)\4/gi,
    replace: (_match, keyQuote, key, separator, valueQuote) =>
      `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${PLACEHOLDER}${valueQuote}`,
  },
  // Email addresses.
  { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

/**
 * Replaces the current user's home directory with `~`.
 *
 * Stack traces from developer machines otherwise carry the account name in
 * every frame.
 */
function redactHomePath(text) {
  let home;
  try {
    home = os.homedir();
  } catch {
    return text;
  }
  if (!home || home === "/") return text;
  return text.split(home).join("~");
}

/**
 * Applies the default patterns, then any user-supplied ones, to a string.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {Array<RegExp|{pattern: RegExp, replace?: Function|string}>} [options.patterns] Extra user patterns.
 * @param {boolean} [options.defaults=true] Apply the built-in patterns.
 * @param {boolean} [options.homePaths=true] Replace the home directory with `~`.
 * @returns {string}
 */
function redact(text, options = {}) {
  if (typeof text !== "string" || text === "") return text;

  const { patterns = [], defaults = true, homePaths = true } = options;
  let output = text;

  const all = [...(defaults ? DEFAULT_PATTERNS : []), ...patterns.map(toRule)];

  for (const rule of all) {
    if (!rule || !rule.pattern) continue;
    try {
      // Clone so a user-supplied global regex cannot carry lastIndex between calls.
      const pattern = new RegExp(rule.pattern.source, ensureGlobal(rule.pattern.flags));
      output = output.replace(pattern, rule.replace || PLACEHOLDER);
    } catch {
      // A bad user pattern must not break reporting.
    }
  }

  return homePaths ? redactHomePath(output) : output;
}

/**
 * Keys whose value is redacted outright, whatever it looks like.
 *
 * A bare `"hunter2"` matches no pattern on its own, so pattern matching alone
 * would happily publish `context: { password: "hunter2" }`.
 */
const SECRET_KEY =
  /^(?:pass|passwd|password|secret|token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth|authorization|credential|credentials|private[_-]?key|client[_-]?secret|session[_-]?id|cookie|set[_-]?cookie)$/i;

/**
 * Walks a value and redacts every string it contains. Used for user-supplied
 * `context` and `tags`, which are just as likely to hold credentials as a
 * stack trace is.
 *
 * @param {*} value
 * @param {object} [options] Same options as {@link redact}.
 * @param {number} [depth] Internal recursion guard.
 * @returns {*}
 */
function redactDeep(value, options = {}, depth = 0) {
  if (depth > 6) return value;

  if (typeof value === "string") return redact(value, options);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, options, depth + 1));

  if (value && typeof value === "object") {
    if (value instanceof Error) return redact(value.stack || value.message, options);
    if (value instanceof Date) return value.toISOString();

    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] =
        options.defaults !== false && SECRET_KEY.test(key)
          ? PLACEHOLDER
          : redactDeep(item, options, depth + 1);
    }
    return output;
  }

  return value;
}

function toRule(entry) {
  if (entry instanceof RegExp) return { pattern: entry };
  return entry;
}

function ensureGlobal(flags) {
  return flags.includes("g") ? flags : `${flags}g`;
}

module.exports = { redact, redactDeep, DEFAULT_PATTERNS, SECRET_KEY, PLACEHOLDER };
