"use strict";

const { fingerprint: computeFingerprint } = require("./fingerprint");
const { redact, redactDeep } = require("./redact");
const { resolveConfig, getRuntimeInfo } = require("./config");
const { formatIssue: defaultFormatIssue, formatDuplicateComment } = require("./format");

/**
 * Reports an error.
 *
 * Never throws and never rejects: an error reporter that crashes the app is
 * worse than no reporter. Anything that goes wrong internally is passed to the
 * `onError` callback and reported back as `status: "skipped"`.
 *
 * Pipeline order is deliberate:
 *   redact → fingerprint → count → beforeSend → throttle → dedupe → send
 *
 * Redaction runs first so secrets never reach the hash, the log, or the wire.
 * Counting happens before throttling so the occurrence count reflects every
 * occurrence, not just the ones that were filed. `beforeSend` runs before the
 * throttle so a cancelled report does not consume the hourly budget.
 *
 * @param {Error|unknown} error
 * @param {object} [options]
 * @returns {Promise<{status: "created"|"duplicate"|"unreported"|"skipped", url?: string, issueNumber?: number, fingerprint?: string, reason?: string}>}
 */
async function reportError(error, options = {}) {
  let config = null;
  try {
    config = resolveConfig(options);
    return await run(error, config);
  } catch (internalError) {
    return handleInternalError(internalError, config, options);
  }
}

async function run(error, config) {
  const log = config.log;

  if (!config.enabled) return skipped("disabled");

  const environment = process.env.NODE_ENV || "development";
  if (Array.isArray(config.environments) && !config.environments.includes(environment)) {
    log.debug(`skipping report: environment "${environment}" is not enabled`);
    return skipped("environment");
  }

  if (config.sampleRate < 1 && Math.random() >= config.sampleRate) {
    log.debug("skipping report: sampled out");
    return skipped("sampled");
  }

  // --- normalize + redact -------------------------------------------------
  const normalized = toError(error);
  const redactOptions = redactionOptions(config);

  const message = redact(normalized.message, redactOptions);
  const stack = redact(normalized.stack || "", redactOptions);

  // --- fingerprint --------------------------------------------------------
  const hash = computeFingerprint(
    { name: normalized.name, message, stack },
    { frames: config.fingerprintFrames },
  );

  // --- count (every occurrence, reported or not) --------------------------
  const cached = config.cache.touch(hash);

  const report = {
    fingerprint: hash,
    name: normalized.name,
    message,
    stack,
    error: normalized,
    timestamp: new Date().toISOString(),
    firstSeen: new Date(cached.firstSeen).toISOString(),
    occurrenceCount: cached.count,
    source: config.source || "manual",
    context: redactDeep(config.context || {}, redactOptions),
    tags: redactDeep(config.tags || [], redactOptions),
    runtime: getRuntimeInfo(),
    labels: config.labels,
    assignees: config.assignees,
    milestone: config.milestone,
  };

  // --- beforeSend ---------------------------------------------------------
  if (typeof config.beforeSend === "function") {
    const result = await config.beforeSend(report);
    if (result === null || result === false) {
      log.debug(`report cancelled by beforeSend (${hash})`);
      return skipped("before-send", hash);
    }
    if (result && typeof result === "object") Object.assign(report, result);
  }

  // --- spam guards --------------------------------------------------------
  const verdict = config.throttle.check(report.fingerprint);
  if (!verdict.allowed) {
    log.debug(
      `report suppressed (${verdict.reason}): ${report.fingerprint}, ` +
        `retry in ${Math.ceil((verdict.retryAfterMs || 0) / 1000)}s`,
    );
    return { status: "skipped", reason: verdict.reason, fingerprint: report.fingerprint };
  }

  const issue = buildIssue(report, config);

  // --- dry run ------------------------------------------------------------
  if (config.dryRun) {
    log.info(`dry run — would file: ${issue.title}`);
    log.debug(issue.body);
    return { status: "skipped", reason: "dry-run", fingerprint: report.fingerprint, issue };
  }

  const transport = config.transportInstance;
  if (!transport) {
    log.error("no transport configured — pass `repoUrl` or a custom `transport`");
    return skipped("no-transport", report.fingerprint);
  }

  // From here on we are touching the network; spend the budget now so a crash
  // loop cannot retry immediately if the request below fails.
  config.throttle.record(report.fingerprint);

  const existing = await findExisting(report.fingerprint, config, transport);
  if (existing) return await handleDuplicate(existing, report, config, transport);

  // --- no credentials: hand back a prefilled link -------------------------
  if (transport.canCreate === false) {
    const url = transport.newIssueUrl ? transport.newIssueUrl(issue) : undefined;
    log.info(`not reported yet — open to file it:\n  ${url}`);
    return { status: "unreported", url, fingerprint: report.fingerprint };
  }

  // --- create -------------------------------------------------------------
  try {
    const created = await transport.create({
      ...issue,
      assignees: report.assignees,
      milestone: report.milestone,
    });
    config.cache.link(report.fingerprint, {
      issueNumber: created.issueNumber,
      url: created.url,
      state: "open",
    });
    log.info(`issue created: ${created.url}`);
    return {
      status: "created",
      url: created.url,
      issueNumber: created.issueNumber,
      fingerprint: report.fingerprint,
    };
  } catch (transportError) {
    config.log.error(`failed to create issue: ${transportError.message}`);
    notifyError(config, transportError);
    return skipped("transport-error", report.fingerprint);
  }
}

/**
 * Looks for an existing issue: local cache first, then the transport.
 *
 * A search failure is not fatal. Losing deduplication is better than losing
 * the report, so the pipeline continues as if nothing was found.
 */
async function findExisting(hash, config, transport) {
  const cached = config.cache.get(hash);
  if (cached && cached.issueNumber) {
    config.log.debug(`fingerprint ${hash} known locally as #${cached.issueNumber}`);
    return { issueNumber: cached.issueNumber, url: cached.url, state: cached.state || "open" };
  }

  if (typeof transport.search !== "function") return null;

  try {
    return await transport.search(hash);
  } catch (error) {
    config.log.warn(`could not search for duplicates: ${error.message}`);
    notifyError(config, error);
    return null;
  }
}

/**
 * Handles a fingerprint that already has an issue: reopen it when it was
 * closed (that is a regression, not a duplicate) and leave a comment so the
 * occurrence count is visible to whoever is triaging.
 */
async function handleDuplicate(existing, report, config, transport) {
  const log = config.log;
  let state = existing.state;

  if (state === "closed" && config.reopenClosed && typeof transport.reopen === "function") {
    try {
      await transport.reopen(existing.issueNumber);
      state = "open";
      report.reopened = true;
      log.info(`reopened #${existing.issueNumber} — regression of ${report.fingerprint}`);
    } catch (error) {
      log.warn(`could not reopen #${existing.issueNumber}: ${error.message}`);
      notifyError(config, error);
    }
  }

  if (config.commentOnDuplicate && typeof transport.comment === "function") {
    try {
      await transport.comment(existing.issueNumber, formatDuplicateComment(report));
      log.debug(`commented on #${existing.issueNumber}`);
    } catch (error) {
      log.warn(`could not comment on #${existing.issueNumber}: ${error.message}`);
      notifyError(config, error);
    }
  }

  config.cache.link(report.fingerprint, {
    issueNumber: existing.issueNumber,
    url: existing.url,
    state,
  });

  log.info(`duplicate of ${existing.url || `#${existing.issueNumber}`}`);
  return {
    status: "duplicate",
    url: existing.url,
    issueNumber: existing.issueNumber,
    fingerprint: report.fingerprint,
  };
}

function buildIssue(report, config) {
  const format = typeof config.formatIssue === "function" ? config.formatIssue : defaultFormatIssue;

  let issue;
  try {
    issue = format(report);
  } catch (error) {
    config.log.warn(`custom formatIssue threw, falling back to the default: ${error.message}`);
    notifyError(config, error);
    issue = defaultFormatIssue(report);
  }

  return {
    title: issue.title,
    body: issue.body,
    labels: issue.labels || config.labels,
  };
}

function redactionOptions(config) {
  if (config.redact === false) {
    return { defaults: false, patterns: [], homePaths: false };
  }
  const custom = typeof config.redact === "object" ? config.redact : {};
  return {
    defaults: custom.defaults !== false,
    patterns: [...(config.redactPatterns || []), ...(custom.patterns || [])],
    homePaths: config.redactHomePaths !== false,
  };
}

function toError(value) {
  if (value instanceof Error) return value;
  if (value && typeof value === "object" && value.message) {
    const error = new Error(String(value.message));
    if (value.name) error.name = String(value.name);
    if (value.stack) error.stack = String(value.stack);
    return error;
  }
  return new Error(String(value));
}

function skipped(reason, hash) {
  return { status: "skipped", reason, fingerprint: hash };
}

function notifyError(config, error) {
  if (!config || typeof config.onError !== "function") return;
  try {
    config.onError(error);
  } catch {
    // An onError handler that throws is the caller's problem, not the app's.
  }
}

function handleInternalError(error, config, options) {
  try {
    if (config && config.log) config.log.error(`internal failure: ${error.message}`);
    else if (options && options.logLevel !== "silent" && !options.silent) {
      console.error("[bug-reporter] internal failure:", error.message);
    }
    notifyError(config || options, error);
  } catch {
    // Nothing left to do — the guarantee is that we do not throw.
  }
  return { status: "skipped", reason: "internal-error" };
}

module.exports = { reportError, formatIssue: defaultFormatIssue };
