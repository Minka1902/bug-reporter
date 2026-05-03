"use strict";

const { reportError } = require("./reporter");

let _config = null;
let _attached = false;

/**
 * Initialise auto-capture.  Call once at app startup.
 *
 * @param {object} config
 * @param {string} config.repoUrl  - GitHub repo URL or "owner/repo".
 * @param {string} [config.token] - GitHub PAT for automatic issue creation.
 * @param {boolean} [config.silent=false]
 * @param {boolean} [config.captureUnhandledRejections=true]
 */
function init(config = {}) {
  if (!config.repoUrl) throw new Error("[bug-reporter] repoUrl is required in init()");

  _config = {
    repoUrl: config.repoUrl,
    token: config.token || null,
    silent: config.silent || false,
    captureUnhandledRejections: config.captureUnhandledRejections !== false,
  };

  if (_attached) return; // don't double-attach
  _attached = true;

  process.on("uncaughtException", (error) => {
    _safeReport(error, "uncaughtException");
  });

  if (_config.captureUnhandledRejections) {
    process.on("unhandledRejection", (reason) => {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      _safeReport(error, "unhandledRejection");
    });
  }
}

function _safeReport(error, source) {
  if (!_config) return;
  reportError(error, {
    repoUrl: _config.repoUrl,
    token: _config.token,
    silent: _config.silent,
    extra: { source },
  }).catch(() => {
    // never let the reporter itself crash the process
  });
}

/**
 * Remove the global handlers (useful in tests).
 */
function detach() {
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
  _attached = false;
  _config = null;
}

module.exports = { init, detach };
