"use strict";

const fs = require("node:fs");

const { reportError } = require("./reporter");
const { resolveConfig, setInstalledConfig, clearInstalledConfig } = require("./config");

let handlers = null;
let installedOptions = null;
let resolved = null;
let reporting = false;

/**
 * Attaches global error handlers. Call once at application startup.
 *
 * This is the feature the package exists for: without it, reporting only
 * happens where someone remembered to write a try/catch.
 *
 * Crash semantics are preserved by default. Registering an `uncaughtException`
 * listener silently stops Node from exiting, which would leave a process
 * running in the undefined state Node deliberately aborts on — so the handler
 * reports (with a timeout) and then exits 1, exactly as Node would have. Set
 * `exitOnUncaught: false` to keep the process alive instead.
 *
 * @param {object} options See README for the full list.
 * @returns {() => void} An uninstall function.
 */
function install(options = {}) {
  if (!options.repoUrl && !options.transport) {
    throw new Error("[bug-reporter] install() requires `repoUrl` or a custom `transport`");
  }

  installedOptions = { ...options };
  resolved = resolveConfig(installedOptions);
  setInstalledConfig(installedOptions);

  if (handlers) return uninstall; // Already attached; the new config is live.

  handlers = {
    uncaughtException: (error) => {
      void handleFatal(error, "uncaughtException");
    },
    unhandledRejection: (reason) => {
      void handleFatal(reason, "unhandledRejection");
    },
  };

  process.on("uncaughtException", handlers.uncaughtException);
  if (resolved.captureUnhandledRejections !== false) {
    process.on("unhandledRejection", handlers.unhandledRejection);
  }

  return uninstall;
}

/**
 * Removes the handlers this package installed.
 *
 * Only ours: removing every listener for these events would silently disable
 * other libraries' error handling.
 */
function uninstall() {
  if (handlers) {
    process.removeListener("uncaughtException", handlers.uncaughtException);
    process.removeListener("unhandledRejection", handlers.unhandledRejection);
    handlers = null;
  }
  if (resolved && resolved.cache) resolved.cache.flush();

  installedOptions = null;
  resolved = null;
  clearInstalledConfig();
}

async function handleFatal(error, source) {
  // An error thrown while reporting must not re-enter the pipeline.
  if (reporting) return;
  reporting = true;

  const config = resolved || {};
  const fatal = source === "uncaughtException" ? config.exitOnUncaught !== false : shouldExitOnRejection(config);

  // Print first, like Node would, so the operator sees the crash immediately
  // even if the network call below is slow.
  if (fatal) printFatal(error, source);

  try {
    await withTimeout(
      reportError(error, { ...installedOptions, source }),
      config.reportTimeoutMs || 3000,
    );
  } catch {
    // reportError does not throw, but the timeout race is defensive anyway.
  } finally {
    reporting = false;
    if (config.cache) config.cache.flush();

    if (fatal) {
      process.exitCode = 1;
      process.exit(1);
    }
  }
}

/**
 * Node ≥15 treats an unhandled rejection as fatal, but only when nothing is
 * listening — installing our listener suppresses that. Exit to preserve it,
 * unless the process was explicitly started in a non-fatal mode.
 */
function shouldExitOnRejection(config) {
  if (config.exitOnUnhandledRejection !== undefined) return config.exitOnUnhandledRejection;
  return detectRejectionMode() === "throw";
}

function detectRejectionMode() {
  const sources = [...(process.execArgv || []), process.env.NODE_OPTIONS || ""].join(" ");
  const match = /--unhandled-rejections=(\w+)/.exec(sources);
  return match ? match[1] : "throw";
}

function printFatal(error, source) {
  const text = error && error.stack ? error.stack : String(error);
  writeStderr(`${source === "unhandledRejection" ? "Unhandled rejection: " : ""}${text}\n`);
}

function writeStderr(text) {
  try {
    // Synchronous: process.exit() truncates pending async writes on a pipe.
    fs.writeSync(2, text);
  } catch {
    try {
      console.error(text);
    } catch {
      // Give up quietly.
    }
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: "skipped", reason: "report-timeout" }), ms);
    if (typeof timer.unref === "function") timer.unref();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve({ status: "skipped", reason: "internal-error" });
      },
    );
  });
}

module.exports = { install, uninstall };
