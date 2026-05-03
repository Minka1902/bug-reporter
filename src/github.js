"use strict";

const GITHUB_API = "https://api.github.com";

/**
 * Parses a GitHub repo URL into { owner, repo }.
 * Accepts:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   owner/repo
 */
function parseRepoUrl(repoUrl) {
  if (!repoUrl) throw new Error("repoUrl is required");

  // Already in "owner/repo" short form
  if (/^[^/]+\/[^/]+$/.test(repoUrl)) {
    const [owner, repo] = repoUrl.split("/");
    return { owner, repo: repo.replace(/\.git$/, "") };
  }

  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) throw new Error(`Cannot parse GitHub repo URL: ${repoUrl}`);
  return { owner: match[1], repo: match[2] };
}

function buildHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/**
 * Search open issues for a title similar to the error message.
 * Returns the first matching issue URL, or null.
 */
async function findSimilarIssue(owner, repo, errorTitle, token) {
  const fetch = (await import("node-fetch")).default;
  const q = encodeURIComponent(`${errorTitle} repo:${owner}/${repo} is:issue is:open`);
  const url = `${GITHUB_API}/search/issues?q=${q}&per_page=1`;

  const res = await fetch(url, { headers: buildHeaders(token) });
  if (!res.ok) return null;

  const data = await res.json();
  if (data.items && data.items.length > 0) {
    return data.items[0].html_url;
  }
  return null;
}

/**
 * Create a new GitHub issue and return its URL.
 */
async function createIssue(owner, repo, token, { title, body, labels }) {
  const fetch = (await import("node-fetch")).default;
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues`;

  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify({ title, body, labels }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`GitHub API error ${res.status}: ${err.message || res.statusText}`);
  }

  const data = await res.json();
  return data.html_url;
}

module.exports = { parseRepoUrl, findSimilarIssue, createIssue };
