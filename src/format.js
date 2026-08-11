"use strict";

const { fingerprintMarker } = require("./fingerprint");
const { PACKAGE } = require("./config");

/** GitHub rejects issue titles longer than this. */
const TITLE_LIMIT = 256;

/** Stack traces beyond this are truncated so the body stays readable. */
const STACK_LIMIT = 8000;

/**
 * Renders a report as a GitHub issue.
 *
 * Auto-filed issues are only worth having if they are actionable, so the body
 * carries everything a maintainer would otherwise have to ask for: the stack,
 * the runtime, when it started, how often it happens, and the caller's own
 * context and tags.
 *
 * Override it wholesale with the `formatIssue` option — nobody should have to
 * fork the package to change the template.
 *
 * @param {object} report
 * @returns {{title: string, body: string, labels: string[]}}
 */
function formatIssue(report) {
  return {
    title: formatTitle(report),
    body: formatBody(report),
    labels: report.labels || [],
  };
}

function formatTitle(report) {
  const name = report.name || "Error";
  const message = firstLine(report.message) || "unknown error";
  return truncate(`${name}: ${message}`, TITLE_LIMIT);
}

function formatBody(report) {
  const runtime = report.runtime || {};

  const lines = [
    // Deduplication depends on this marker surviving edits.
    fingerprintMarker(report.fingerprint),
    "",
    `**${escapeInline(report.name || "Error")}: ${escapeInline(firstLine(report.message))}**`,
    "",
    "| | |",
    "| --- | --- |",
    `| **Fingerprint** | \`${report.fingerprint}\` |`,
    `| **First seen** | ${report.firstSeen || report.timestamp} |`,
    `| **Last seen** | ${report.timestamp} |`,
    `| **Occurrences** | ${report.occurrenceCount || 1} |`,
    `| **Source** | \`${report.source || "manual"}\` |`,
    `| **Environment** | ${runtime.environment || "unknown"} |`,
    "",
  ];

  if (report.stack) {
    lines.push("### Stack trace", "", "```text", truncate(report.stack, STACK_LIMIT), "```", "");
  }

  if (hasEntries(report.context)) {
    lines.push(
      "### Context",
      "",
      "```json",
      safeJson(report.context),
      "```",
      "",
    );
  }

  if (report.tags && report.tags.length) {
    lines.push("### Tags", "", report.tags.map((tag) => `\`${tag}\``).join(" "), "");
  }

  lines.push(
    "### Runtime",
    "",
    "| | |",
    "| --- | --- |",
    `| **Node** | ${runtime.node || "unknown"} |`,
    `| **OS** | ${runtime.os || runtime.platform || "unknown"} |`,
    `| **Arch** | ${runtime.arch || "unknown"} |`,
  );
  if (runtime.package) lines.push(`| **Package** | ${runtime.package} |`);
  lines.push(`| **Reporter** | ${runtime.reporter || PACKAGE.name} |`, "");

  lines.push(
    "---",
    "",
    `_Filed automatically by [${PACKAGE.name}](https://www.npmjs.com/package/${PACKAGE.name}). ` +
      "The HTML comment at the top of this body carries the fingerprint used to " +
      "deduplicate reports — removing it will cause this bug to be filed again._",
  );

  return lines.join("\n");
}

/**
 * Renders the "seen again" comment posted on a duplicate.
 *
 * Silence on a duplicate wastes the signal; a running count tells a maintainer
 * whether they are looking at a one-off or an outage.
 */
function formatDuplicateComment(report) {
  const runtime = report.runtime || {};

  const lines = [
    `Seen again — **${report.occurrenceCount || 1} occurrence${
      report.occurrenceCount === 1 ? "" : "s"
    }** since ${report.firstSeen || report.timestamp}.`,
    "",
    "| | |",
    "| --- | --- |",
    `| **Last seen** | ${report.timestamp} |`,
    `| **Environment** | ${runtime.environment || "unknown"} |`,
    `| **Node** | ${runtime.node || "unknown"} |`,
  ];
  if (runtime.package) lines.push(`| **Package** | ${runtime.package} |`);
  lines.push(`| **Fingerprint** | \`${report.fingerprint}\` |`, "");

  if (report.stack) {
    lines.push(
      "<details><summary>Latest stack trace</summary>",
      "",
      "```text",
      truncate(report.stack, STACK_LIMIT),
      "```",
      "",
      "</details>",
      "",
    );
  }

  if (report.reopened) {
    lines.push(
      "> This issue was closed and has occurred again — reopening as a regression.",
      "",
    );
  }

  lines.push(`_Reported automatically by ${PACKAGE.name}._`);
  return lines.join("\n");
}

function truncate(text, limit) {
  const value = String(text == null ? "" : text);
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function firstLine(text) {
  return String(text == null ? "" : text).split("\n")[0].trim();
}

function escapeInline(text) {
  return String(text == null ? "" : text).replace(/([*_`|])/g, "\\$1");
}

function hasEntries(value) {
  return Boolean(value) && typeof value === "object" && Object.keys(value).length > 0;
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

module.exports = { formatIssue, formatDuplicateComment, TITLE_LIMIT, truncate };
