"use strict";

const { parseRepoUrl, findSimilarIssue, createIssue } = require("./github");

/**
 * Formats an Error into a GitHub issue title and markdown body.
 */
function formatIssue(error, context = {}) {
  const title = `Bug: ${error.name || "Error"}: ${error.message}`.slice(0, 256);

  const lines = [
    "## Automatic Bug Report",
    "",
    `**Error:** \`${error.name || "Error"}\``,
    `**Message:** ${error.message}`,
    "",
  ];

  if (error.stack) {
    lines.push("### Stack Trace", "```", error.stack, "```", "");
  }

  if (context.file) lines.push(`**File:** \`${context.file}\``);
  if (context.line) lines.push(`**Line:** ${context.line}`);
  if (context.nodeVersion) lines.push(`**Node.js:** ${context.nodeVersion}`);
  if (context.platform) lines.push(`**Platform:** ${context.platform}`);
  if (context.extra) {
    lines.push("", "### Additional Context", "```json", JSON.stringify(context.extra, null, 2), "```");
  }

  lines.push("", "---", "*Reported automatically by [auto-github-bug-reporter](https://www.npmjs.com/package/auto-github-bug-reporter)*");

  return { title, body: lines.join("\n") };
}

/**
 * Collects useful runtime context automatically.
 */
function getRuntimeContext() {
  return {
    nodeVersion: process.version,
    platform: process.platform,
  };
}

/**
 * Main report function.
 *
 * @param {Error} error - The error to report.
 * @param {object} options
 * @param {string} options.repoUrl  - Full GitHub URL or "owner/repo".
 * @param {string} [options.token] - GitHub personal access token (enables issue creation).
 * @param {boolean} [options.silent=false] - Suppress all console output.
 * @param {object} [options.extra]  - Any extra data to attach to the issue body.
 * @returns {Promise<{status: string, url?: string}>}
 */
async function reportError(error, options = {}) {
  const { repoUrl, token, silent = false, extra } = options;

  const log = (...args) => { if (!silent) console.log(...args); };
  const warn = (...args) => { if (!silent) console.warn(...args); };

  if (!(error instanceof Error)) {
    error = new Error(String(error));
  }

  let owner, repo;
  try {
    ({ owner, repo } = parseRepoUrl(repoUrl));
  } catch (e) {
    warn(`[bug-reporter] Invalid repoUrl: ${e.message}`);
    return { status: "error", message: e.message };
  }

  const context = { ...getRuntimeContext(), extra };
  const { title, body } = formatIssue(error, context);

  // Search for a similar existing issue first
  let existingUrl = null;
  try {
    existingUrl = await findSimilarIssue(owner, repo, error.message, token);
  } catch (e) {
    warn(`[bug-reporter] Could not search issues: ${e.message}`);
  }

  if (existingUrl) {
    log(`[bug-reporter] A similar issue already exists:\n  ${existingUrl}`);
    return { status: "existing", url: existingUrl };
  }

  if (!token) {
    const newIssueUrl = `https://github.com/${owner}/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    warn(`[bug-reporter] Issue not yet reported. Open to create it:\n  ${newIssueUrl}`);
    return { status: "not_reported", url: newIssueUrl };
  }

  try {
    const issueUrl = await createIssue(owner, repo, token, {
      title,
      body,
      labels: ["bug", "auto-reported"],
    });
    log(`[bug-reporter] Issue created: ${issueUrl}`);
    return { status: "created", url: issueUrl };
  } catch (e) {
    warn(`[bug-reporter] Failed to create issue: ${e.message}`);
    return { status: "error", message: e.message };
  }
}

module.exports = { reportError, formatIssue };
