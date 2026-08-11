"use strict";

const LEVELS = { silent: 0, error: 1, info: 2, debug: 3 };

const PREFIX = "[bug-reporter]";

/**
 * Builds the logger used across the package.
 *
 * Accepts either a `logLevel` string or an injected `logger` object exposing
 * `error` / `warn` / `info` / `debug` (the shape pino and winston already
 * have), so the reporter can write into an app's existing logging setup.
 *
 * @param {object} [options]
 * @param {"silent"|"error"|"info"|"debug"} [options.logLevel="error"]
 * @param {{error?:Function, warn?:Function, info?:Function, debug?:Function}} [options.logger]
 * @returns {{error:Function, warn:Function, info:Function, debug:Function, level:string}}
 */
function createLogger(options = {}) {
  const { logger, logLevel } = options;
  const level = LEVELS[logLevel] === undefined ? LEVELS.error : LEVELS[logLevel];

  if (logger) {
    // An injected logger owns its own filtering; we only forward.
    return {
      level: logLevel || "error",
      error: bind(logger.error, logger),
      warn: bind(logger.warn || logger.error, logger),
      info: bind(logger.info, logger),
      debug: bind(logger.debug, logger),
    };
  }

  const write = (min, method) => (...args) => {
    if (level >= min) {
      try {
        console[method](PREFIX, ...args);
      } catch {
        // A broken console must not break the error path.
      }
    }
  };

  return {
    level: logLevel || "error",
    error: write(LEVELS.error, "error"),
    warn: write(LEVELS.error, "warn"),
    info: write(LEVELS.info, "log"),
    debug: write(LEVELS.debug, "log"),
  };
}

function bind(fn, thisArg) {
  if (typeof fn !== "function") return () => {};
  return (...args) => {
    try {
      fn.apply(thisArg, args);
    } catch {
      // Never let logging throw into the error path.
    }
  };
}

/** True when `value` is a usable log level. */
function isLogLevel(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LEVELS, value);
}

module.exports = { createLogger, isLogLevel, LEVELS };
