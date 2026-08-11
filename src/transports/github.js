"use strict";

const { fingerprintMarker, extractFingerprint, MARKER_PREFIX } = require("../fingerprint");
const { backoffDelay, retryAfterMs } = require("../throttle");

const GITHUB_API = "https://api.github.com";
const RETRYABLE_STATUSES = new Set([403, 408, 429, 500, 502, 503, 504]);

/**
 * Parses a GitHub repo URL into { owner, repo }.
 * Accepts:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *   owner/repo
 *
 * @param {string} repoUrl
 * @returns {{owner: string, repo: string}}
 */
function parseRepoUrl(repoUrl) {
  if (!repoUrl) throw new Error("repoUrl is required");

  // Already in "owner/repo" short form.
  if (/^[^/\s:]+\/[^/\s:]+$/.test(repoUrl)) {
    const [owner, repo] = repoUrl.split("/");
    return { owner, repo: repo.replace(/\.git$/, "") };
  }

  const match = String(repoUrl).match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) throw new Error(`Cannot parse GitHub repo URL: ${repoUrl}`);
  return { owner: match[1], repo: match[2] };
}

/** Error carrying the HTTP status, so the reporter can tell apart retryable failures. */
class TransportError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = "TransportError";
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * GitHub adapter for the transport interface.
 *
 * The core pipeline only ever calls `search` / `create` / `comment` / `reopen`,
 * so a GitLab, Jira, Linear or webhook adapter can be dropped in without
 * touching anything else.
 *
 * @param {object} options
 * @param {string} options.repoUrl
 * @param {string} [options.token] Fine-grained PAT with Issues: read and write.
 * @param {typeof fetch} [options.fetch] Injectable for tests and custom agents.
 * @param {string} [options.apiBase]
 * @param {number} [options.timeoutMs=10000] Per-request timeout.
 * @param {number} [options.maxRetries=2]
 * @param {number} [options.maxRetryDelayMs=30000] Give up rather than wait longer than this.
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
function createGitHubTransport(options = {}) {
  const {
    repoUrl,
    token = null,
    apiBase = GITHUB_API,
    timeoutMs = 10000,
    maxRetries = 2,
    maxRetryDelayMs = 30000,
    logger = null,
    now = Date.now,
    sleep = defaultSleep,
  } = options;

  const doFetch = options.fetch || globalThis.fetch;
  const { owner, repo } = parseRepoUrl(repoUrl);

  // Set when GitHub tells us the quota is gone; short-circuits until it resets
  // instead of burning further requests from inside an error handler.
  let rateLimitedUntil = 0;

  function headers() {
    const base = {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "auto-github-bug-reporter",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) base.Authorization = `Bearer ${token}`;
    return base;
  }

  async function request(pathname, init = {}) {
    if (typeof doFetch !== "function") {
      throw new TransportError("global fetch is unavailable — Node 18+ is required");
    }

    const waitLeft = rateLimitedUntil - now();
    if (waitLeft > 0) {
      throw new TransportError(`rate limited for another ${Math.ceil(waitLeft / 1000)}s`, {
        status: 429,
        retryable: true,
      });
    }

    const url = pathname.startsWith("http") ? pathname : `${apiBase}${pathname}`;
    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let response;
      try {
        response = await doFetch(url, {
          ...init,
          headers: { ...headers(), ...(init.headers || {}) },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        // Network failure, DNS, or timeout — retry, then give up quietly.
        lastError = new TransportError(`request failed: ${error.message}`, { retryable: true });
        if (attempt === maxRetries) break;
        await sleep(backoffDelay(attempt));
        continue;
      }

      if (response.ok) return response.status === 204 ? {} : await readJson(response);

      const retryable = RETRYABLE_STATUSES.has(response.status);
      const headerWait = retryAfterMs(response.headers, now);

      if (isRateLimited(response)) {
        rateLimitedUntil = now() + (headerWait || 60000);
      }

      lastError = new TransportError(
        `GitHub API ${response.status}: ${await readMessage(response)}`,
        { status: response.status, retryable },
      );

      if (!retryable || attempt === maxRetries) break;

      const wait = headerWait === null ? backoffDelay(attempt) : headerWait;
      if (wait > maxRetryDelayMs) {
        // Waiting out a long reset window inside an error handler is worse
        // than dropping the report; the local cache will hold it back anyway.
        break;
      }
      if (logger) logger.debug(`retrying in ${wait}ms after ${response.status}`);
      await sleep(wait);
    }

    throw lastError || new TransportError("request failed");
  }

  return {
    name: "github",
    owner,
    repo,
    /** Whether this transport can file issues, or only produce a link. */
    canCreate: Boolean(token),

    /**
     * Finds an existing issue carrying this fingerprint.
     *
     * Searches every state, not just open: a match on a closed issue is a
     * regression, and filing a fresh duplicate would hide it.
     *
     * @param {string} fingerprint
     * @returns {Promise<{issueNumber:number, url:string, state:string, body:string}|null>}
     */
    async search(fingerprint) {
      const query = `repo:${owner}/${repo} is:issue in:body "${MARKER_PREFIX}${fingerprint}"`;
      const data = await request(
        `/search/issues?q=${encodeURIComponent(query)}&per_page=5&advanced_search=true`,
      );

      for (const item of data.items || []) {
        // Verify rather than trust: GitHub's search tokenizes the marker, so a
        // hit is a candidate, not proof. Comparing the embedded fingerprint
        // makes deduplication exact.
        if (extractFingerprint(item.body) === fingerprint) {
          return {
            issueNumber: item.number,
            url: item.html_url,
            state: item.state,
            body: item.body,
          };
        }
      }
      return null;
    },

    /**
     * @param {{title:string, body:string, labels?:string[], assignees?:string[], milestone?:number}} issue
     * @returns {Promise<{issueNumber:number, url:string}>}
     */
    async create(issue) {
      const payload = {
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
      };
      if (issue.assignees && issue.assignees.length) payload.assignees = issue.assignees;
      if (issue.milestone !== undefined && issue.milestone !== null) {
        payload.milestone = issue.milestone;
      }

      const data = await request(`/repos/${owner}/${repo}/issues`, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      return { issueNumber: data.number, url: data.html_url };
    },

    /** Posts a "seen again" comment on an existing issue. */
    async comment(issueNumber, body) {
      const data = await request(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      return { url: data.html_url };
    },

    /** Reopens a closed issue — a fingerprint match on a closed issue is a regression. */
    async reopen(issueNumber) {
      const data = await request(`/repos/${owner}/${repo}/issues/${issueNumber}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "open", state_reason: "reopened" }),
      });
      return { url: data.html_url, state: data.state };
    },

    /** Pre-filled "new issue" link, used when no token is configured. */
    newIssueUrl({ title, body, labels }) {
      const params = new URLSearchParams({ title, body: truncateQuery(body) });
      if (labels && labels.length) params.set("labels", labels.join(","));
      return `https://github.com/${owner}/${repo}/issues/new?${params.toString()}`;
    },
  };
}

function isRateLimited(response) {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  return response.headers.get("x-ratelimit-remaining") === "0";
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function readMessage(response) {
  try {
    const data = await response.json();
    return data.message || response.statusText || "unknown error";
  } catch {
    return response.statusText || "unknown error";
  }
}

/** GitHub rejects overly long URLs; keep the prefilled body within a safe budget. */
function truncateQuery(body, limit = 6000) {
  if (!body || body.length <= limit) return body;
  return `${body.slice(0, limit)}\n\n_(truncated)_`;
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

module.exports = { createGitHubTransport, parseRepoUrl, TransportError, fingerprintMarker };
