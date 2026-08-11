"use strict";

const crypto = require("node:crypto");

/** How many stack frames take part in the hash by default. */
const DEFAULT_FRAME_COUNT = 5;

/** Marker embedded in every issue body so duplicates can be found exactly. */
const MARKER_PREFIX = "bug-reporter:fp=";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_ADDRESS = /\b0x[0-9a-f]+\b/gi;
const LONG_HEX = /\b[0-9a-f]{12,}\b/gi;
const QUOTED = /'[^']*'|"[^"]*"|`[^`]*`/g;
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/)[^\s'"()[\],;]+/g;
// No trailing \b: a unit suffix such as the "ms" in "3000ms" is a word
// character, which would otherwise stop the number from being normalized.
const NUMBER = /\b\d+(?:\.\d+)?/g;

/**
 * Strips the volatile parts of an error message so the same bug always
 * normalizes to the same text.
 *
 * `Cannot read properties of undefined (reading 'x')` and the same error for
 * `'y'` both become `Cannot read properties of undefined (reading <value>)`.
 *
 * @param {string} message
 * @returns {string}
 */
function normalizeMessage(message) {
  return String(message == null ? "" : message)
    .replace(UUID, "<uuid>")
    .replace(HEX_ADDRESS, "<hex>")
    .replace(QUOTED, "<value>")
    .replace(ABSOLUTE_PATH, "<path>")
    .replace(LONG_HEX, "<hex>")
    .replace(NUMBER, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reduces a file path to its last two segments, which identifies the module
 * without pinning the fingerprint to a machine's directory layout.
 */
function normalizeFile(file) {
  const cleaned = String(file)
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/:\d+:\d+$/, "");

  if (/^node:/.test(cleaned)) return cleaned;

  const segments = cleaned.split("/").filter(Boolean);
  if (segments.length <= 2) return segments.join("/");
  return segments.slice(-2).join("/");
}

/**
 * Parses one `at ...` stack line into `function@file`.
 *
 * Line and column are deliberately dropped: they churn on every edit above the
 * failing line, which would split one bug across many fingerprints.
 *
 * @param {string} line
 * @returns {string|null}
 */
function normalizeFrame(line) {
  const match = /^\s*at\s+(?:(?:async\s+)?(.+?)\s+\()?([^()]+?)\)?\s*$/.exec(line);
  if (!match) return null;

  const fn = (match[1] || "<anonymous>").trim();
  const file = normalizeFile(match[2] || "<unknown>");
  return `${fn}@${file}`;
}

/**
 * Returns the top N normalized frames of a stack trace.
 *
 * @param {string} [stack]
 * @param {number} [count]
 * @returns {string[]}
 */
function topFrames(stack, count = DEFAULT_FRAME_COUNT) {
  if (!stack) return [];

  const frames = [];
  for (const line of String(stack).split("\n")) {
    if (!/^\s*at\s/.test(line)) continue;
    const frame = normalizeFrame(line);
    if (frame) frames.push(frame);
    if (frames.length >= count) break;
  }
  return frames;
}

/**
 * Computes a stable fingerprint for an error.
 *
 * Redaction runs before this in the pipeline, so secrets never reach the hash
 * input and a rotating credential in a message cannot split one bug into many
 * fingerprints.
 *
 * @param {{name?: string, message?: string, stack?: string}} error
 * @param {object} [options]
 * @param {number} [options.frames=5] Stack frames to include.
 * @param {number} [options.length=16] Hex characters to keep.
 * @returns {string}
 */
function fingerprint(error, options = {}) {
  const { frames = DEFAULT_FRAME_COUNT, length = 16 } = options;
  const source = error || {};

  const input = [
    source.name || "Error",
    normalizeMessage(source.message),
    ...topFrames(source.stack, frames),
  ].join("\n");

  return crypto.createHash("sha256").update(input).digest("hex").slice(0, length);
}

/** The HTML comment embedded in issue bodies for exact-match deduplication. */
function fingerprintMarker(hash) {
  return `<!-- ${MARKER_PREFIX}${hash} -->`;
}

/** Reads a fingerprint back out of an issue body, or null when absent. */
function extractFingerprint(body) {
  if (!body) return null;
  const match = new RegExp(`${MARKER_PREFIX}([0-9a-f]+)`).exec(String(body));
  return match ? match[1] : null;
}

module.exports = {
  fingerprint,
  fingerprintMarker,
  extractFingerprint,
  normalizeMessage,
  normalizeFrame,
  topFrames,
  DEFAULT_FRAME_COUNT,
  MARKER_PREFIX,
};
