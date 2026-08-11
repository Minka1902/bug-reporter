"use strict";

const { reportError } = require("./src/reporter");
const { install, uninstall } = require("./src/autoCapture");
const { formatIssue, formatDuplicateComment } = require("./src/format");
const { fingerprint, extractFingerprint, fingerprintMarker } = require("./src/fingerprint");
const { redact, DEFAULT_PATTERNS } = require("./src/redact");
const { createGitHubTransport, parseRepoUrl } = require("./src/transports/github");

const warned = new Set();

function deprecate(oldName, newName, fn) {
  return (...args) => {
    if (!warned.has(oldName)) {
      warned.add(oldName);
      console.warn(`[bug-reporter] ${oldName}() is deprecated — use ${newName}() instead.`);
    }
    return fn(...args);
  };
}

module.exports = {
  // Primary API
  install,
  uninstall,
  reportError,
  formatIssue,

  // Building blocks, exposed so templates and transports can be customized
  // without forking the package.
  formatDuplicateComment,
  fingerprint,
  fingerprintMarker,
  extractFingerprint,
  redact,
  redactionPatterns: DEFAULT_PATTERNS,
  createGitHubTransport,
  parseRepoUrl,

  // Deprecated v1 aliases — removed in the next major.
  init: deprecate("init", "install", install),
  detach: deprecate("detach", "uninstall", uninstall),
};
