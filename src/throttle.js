"use strict";

const HOUR_MS = 60 * 60 * 1000;

const DEFAULT_PER_FINGERPRINT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ISSUES_PER_HOUR = 10;

/**
 * Spam guard in front of the transport.
 *
 * Two independent limits:
 *   - per fingerprint: the same bug reaches the transport at most once per
 *     window, which also bounds duplicate comments on an existing issue;
 *   - global: a rolling cap on how many reports may reach the transport in an
 *     hour, so a storm of *distinct* errors cannot flood a repository either.
 *
 * Backed by the fingerprint cache when one is configured, so the limits hold
 * across process restarts rather than resetting on every crash.
 */
class Throttle {
  /**
   * @param {object} [options]
   * @param {number} [options.perFingerprintMs] Minimum gap between reports of one fingerprint.
   * @param {number} [options.maxIssuesPerHour] Rolling cap on reports reaching the transport.
   * @param {object} [options.store] Backing store (a FingerprintCache).
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    this.perFingerprintMs =
      options.perFingerprintMs === undefined
        ? DEFAULT_PER_FINGERPRINT_MS
        : options.perFingerprintMs;
    this.maxIssuesPerHour =
      options.maxIssuesPerHour === undefined
        ? DEFAULT_MAX_ISSUES_PER_HOUR
        : options.maxIssuesPerHour;
    this.store = options.store || createMemoryStore();
    this.now = options.now || Date.now;
  }

  /**
   * @param {string} fingerprint
   * @returns {{allowed: boolean, reason?: string, retryAfterMs?: number}}
   */
  check(fingerprint) {
    const now = this.now();

    if (this.perFingerprintMs > 0) {
      const last = this.store.getReportedAt(fingerprint);
      if (last && now - last < this.perFingerprintMs) {
        return {
          allowed: false,
          reason: "throttled",
          retryAfterMs: this.perFingerprintMs - (now - last),
        };
      }
    }

    if (this.maxIssuesPerHour > 0) {
      const sends = this.store.getSends(now - HOUR_MS);
      if (sends.length >= this.maxIssuesPerHour) {
        const oldest = Math.min(...sends);
        return {
          allowed: false,
          reason: "rate-limited",
          retryAfterMs: HOUR_MS - (now - oldest),
        };
      }
    }

    return { allowed: true };
  }

  /** Records that a report reached the transport. */
  record(fingerprint) {
    this.store.setReported(fingerprint, this.now());
  }
}

function createMemoryStore() {
  const reported = new Map();
  let sends = [];

  return {
    getReportedAt: (fingerprint) => reported.get(fingerprint) || 0,
    setReported: (fingerprint, timestamp) => {
      reported.set(fingerprint, timestamp);
      sends.push(timestamp);
    },
    getSends: (since) => {
      sends = sends.filter((ts) => ts >= since);
      return sends;
    },
  };
}

/**
 * Full-jitter exponential backoff.
 *
 * Jitter matters here: several processes crashing on the same deploy would
 * otherwise retry in lockstep and hit the same rate limit together.
 *
 * @param {number} attempt Zero-based attempt number.
 * @param {object} [options]
 * @returns {number} Delay in milliseconds.
 */
function backoffDelay(attempt, options = {}) {
  const { baseMs = 500, maxMs = 30000, jitter = true, random = Math.random } = options;
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  return jitter ? Math.round(random() * exponential) : exponential;
}

/**
 * Reads how long to wait from a response's rate-limit headers.
 *
 * Honors `retry-after` (seconds or HTTP date) and, when the primary rate limit
 * is exhausted, `x-ratelimit-reset` (epoch seconds).
 *
 * @param {{get: (name: string) => string|null}} headers
 * @param {() => number} [now]
 * @returns {number|null} Milliseconds to wait, or null when the headers say nothing.
 */
function retryAfterMs(headers, now = Date.now) {
  if (!headers || typeof headers.get !== "function") return null;

  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now());
  }

  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining === "0" && reset) {
    const resetMs = Number(reset) * 1000;
    if (Number.isFinite(resetMs)) return Math.max(0, resetMs - now());
  }

  return null;
}

module.exports = {
  Throttle,
  backoffDelay,
  retryAfterMs,
  HOUR_MS,
  DEFAULT_PER_FINGERPRINT_MS,
  DEFAULT_MAX_ISSUES_PER_HOUR,
};
