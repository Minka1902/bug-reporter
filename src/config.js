"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createLogger, isLogLevel } = require("./logger");
const { FingerprintCache } = require("./cache");
const { Throttle } = require("./throttle");
const { createGitHubTransport } = require("./transports/github");
const { DEFAULT_FRAME_COUNT } = require("./fingerprint");

const PACKAGE = safeRequirePackage();

const DEFAULTS = {
  // Target
  repoUrl: null,
  token: null,
  transport: null,

  // Production controls
  enabled: true,
  environments: null,
  sampleRate: 1,
  dryRun: false,

  // Deduplication
  fingerprintFrames: DEFAULT_FRAME_COUNT,
  commentOnDuplicate: true,
  reopenClosed: true,
  cacheFile: null,

  // Spam guards
  perFingerprintMs: 60 * 60 * 1000,
  maxIssuesPerHour: 10,

  // Safety
  redact: true,
  redactPatterns: [],
  redactHomePaths: true,
  beforeSend: null,
  onError: null,

  // Issue content
  labels: ["bug", "auto-reported"],
  assignees: [],
  milestone: null,
  formatIssue: null,
  context: {},
  tags: [],

  // Logging
  logLevel: "error",
  logger: null,

  // HTTP
  timeoutMs: 10000,
  maxRetries: 2,
  apiBase: undefined,
  fetch: undefined,

  // Crash handling
  exitOnUncaught: true,
  reportTimeoutMs: 3000,
  captureUnhandledRejections: true,
};

/** Config captured by install(), used as the base for later reportError calls. */
let installed = null;

/** Shared across calls so throttle and dedup state are process-wide, not per-call. */
let sharedCache = null;
let sharedCacheFile;
let sharedThrottle = null;
let sharedTransport = null;
let sharedTransportKey;

function setInstalledConfig(config) {
  installed = config;
}

function getInstalledConfig() {
  return installed;
}

function clearInstalledConfig() {
  installed = null;
}

/** Drops shared cache/throttle state. Exposed for tests. */
function resetSharedState() {
  if (sharedCache) sharedCache.flush();
  sharedCache = null;
  sharedCacheFile = undefined;
  sharedThrottle = null;
  sharedTransport = null;
  sharedTransportKey = undefined;
}

/**
 * Merges defaults, the config captured by install(), and per-call options into
 * one resolved config, and attaches the logger, cache, throttle and transport.
 *
 * @param {object} [options]
 * @returns {object}
 */
function resolveConfig(options = {}) {
  const merged = { ...DEFAULTS, ...(installed || {}), ...options };

  // Deprecated aliases, kept working for one major version.
  const deprecations = [];
  if (options.silent !== undefined || (installed && installed.silent !== undefined)) {
    const silent = options.silent !== undefined ? options.silent : installed.silent;
    if (options.logLevel === undefined && !(installed && installed.logLevel)) {
      merged.logLevel = silent ? "silent" : "error";
    }
    deprecations.push("`silent` is deprecated — use `logLevel` or an injected `logger`");
  }
  if (options.extra !== undefined) {
    merged.context = { ...(merged.context || {}), ...options.extra };
    deprecations.push("`extra` is deprecated — use `context`");
  }

  if (!isLogLevel(merged.logLevel)) merged.logLevel = DEFAULTS.logLevel;

  const logger = createLogger({ logLevel: merged.logLevel, logger: merged.logger });
  for (const message of deprecations) logger.warn(message);

  merged.log = logger;
  merged.cache = merged.cache || getCache(merged);
  merged.throttle = merged.throttle || getThrottle(merged);
  merged.transportInstance = resolveTransport(merged, logger);

  return merged;
}

function getCache(config) {
  if (!sharedCache || sharedCacheFile !== config.cacheFile) {
    if (sharedCache) sharedCache.flush();
    sharedCache = new FingerprintCache({ file: config.cacheFile });
    sharedCacheFile = config.cacheFile;
    sharedThrottle = null;
  }
  return sharedCache;
}

function getThrottle(config) {
  if (
    !sharedThrottle ||
    sharedThrottle.perFingerprintMs !== config.perFingerprintMs ||
    sharedThrottle.maxIssuesPerHour !== config.maxIssuesPerHour
  ) {
    sharedThrottle = new Throttle({
      perFingerprintMs: config.perFingerprintMs,
      maxIssuesPerHour: config.maxIssuesPerHour,
      store: config.cache,
    });
  }
  return sharedThrottle;
}

function resolveTransport(config, logger) {
  const { transport } = config;

  if (config.transportInstance) return config.transportInstance;
  if (transport && typeof transport === "object") return transport;
  if (typeof transport === "function") return transport({ ...config, logger });
  if (!config.repoUrl) return null;

  // An injected fetch cannot take part in the memo key, so skip the cache
  // rather than hand back a transport bound to a stale implementation.
  if (config.fetch) return createGitHubTransport(githubOptions(config, logger));

  // Memoized: the transport holds the rate-limit backoff window, which has to
  // survive across reports for the short-circuit to be worth anything.
  const key = [config.repoUrl, config.token, config.apiBase, config.timeoutMs].join("|");
  if (!sharedTransport || sharedTransportKey !== key) {
    sharedTransport = createGitHubTransport(githubOptions(config, logger));
    sharedTransportKey = key;
  }
  return sharedTransport;
}

function githubOptions(config, logger) {
  return {
    repoUrl: config.repoUrl,
    token: config.token,
    fetch: config.fetch,
    apiBase: config.apiBase,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    logger,
  };
}

/**
 * Environment details worth having in every issue: they are the first thing a
 * maintainer asks for and the last thing a bug reporter remembers to include.
 */
function getRuntimeInfo() {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    os: `${os.type()} ${os.release()}`,
    environment: process.env.NODE_ENV || "development",
    package: readHostPackage(),
    reporter: `${PACKAGE.name}@${PACKAGE.version}`,
  };
}

let hostPackage;

/** Best-effort read of the host application's name and version. */
function readHostPackage() {
  if (hostPackage !== undefined) return hostPackage;

  hostPackage = null;
  try {
    let directory = process.cwd();
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(directory, "package.json");
      if (fs.existsSync(candidate)) {
        const data = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (data.name) hostPackage = `${data.name}@${data.version || "unknown"}`;
        break;
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    // Not resolvable — the issue body simply omits it.
  }
  return hostPackage;
}

function safeRequirePackage() {
  try {
    return require("../package.json");
  } catch {
    return { name: "auto-github-bug-reporter", version: "0.0.0" };
  }
}

module.exports = {
  DEFAULTS,
  resolveConfig,
  setInstalledConfig,
  getInstalledConfig,
  clearInstalledConfig,
  resetSharedState,
  getRuntimeInfo,
  PACKAGE,
};
