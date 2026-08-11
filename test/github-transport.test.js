"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { createGitHubTransport, parseRepoUrl } = require("../src/transports/github");
const { fingerprintMarker } = require("../src/fingerprint");
const { mockFetch, offlineFetch, recordingSleep } = require("./helpers/mockFetch");

const FP = "a1b2c3d4e5f60718";

function transport(fetchImpl, overrides = {}) {
  return createGitHubTransport({
    repoUrl: "acme/app",
    token: "test-token",
    fetch: fetchImpl,
    sleep: recordingSleep(),
    maxRetries: 0,
    ...overrides,
  });
}

function issueItem(number, fingerprint, state = "open") {
  return {
    number,
    state,
    html_url: `https://github.com/acme/app/issues/${number}`,
    body: `${fingerprintMarker(fingerprint)}\n\nSomething broke`,
  };
}

// --- parseRepoUrl -----------------------------------------------------------

test("parseRepoUrl: accepts the forms people actually paste", () => {
  const expected = { owner: "alice", repo: "my-app" };

  assert.deepStrictEqual(parseRepoUrl("https://github.com/alice/my-app"), expected);
  assert.deepStrictEqual(parseRepoUrl("https://github.com/alice/my-app.git"), expected);
  assert.deepStrictEqual(parseRepoUrl("https://github.com/alice/my-app/"), expected);
  assert.deepStrictEqual(parseRepoUrl("git@github.com:alice/my-app.git"), expected);
  assert.deepStrictEqual(parseRepoUrl("alice/my-app"), expected);
});

test("parseRepoUrl: rejects what it cannot parse", () => {
  assert.throws(() => parseRepoUrl("not-a-url"), /Cannot parse/);
  assert.throws(() => parseRepoUrl(""), /repoUrl is required/);
});

// --- search -----------------------------------------------------------------

test("search: queries every state, not just open issues", async () => {
  const fetchImpl = mockFetch([{ match: "/search/issues", body: { items: [] } }]);
  await transport(fetchImpl).search(FP);

  const query = decodeURIComponent(fetchImpl.calls[0].url);
  assert.ok(query.includes(`bug-reporter:fp=${FP}`));
  assert.ok(query.includes("is:issue"));
  // A closed match is a regression; filtering to open would re-file it.
  assert.ok(!query.includes("is:open"), `query narrowed to open issues: ${query}`);
});

test("search: verifies the marker instead of trusting the search index", async () => {
  const fetchImpl = mockFetch([
    {
      match: "/search/issues",
      body: { items: [issueItem(11, "0000000000000000"), issueItem(12, FP)] },
    },
  ]);

  const found = await transport(fetchImpl).search(FP);

  assert.strictEqual(found.issueNumber, 12);
  assert.strictEqual(found.state, "open");
});

test("search: returns null when nothing carries the fingerprint", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", body: { items: [issueItem(11, "0000000000000000")] } },
  ]);

  assert.strictEqual(await transport(fetchImpl).search(FP), null);
});

test("search: surfaces a closed match so the caller can reopen it", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", body: { items: [issueItem(9, FP, "closed")] } },
  ]);

  const found = await transport(fetchImpl).search(FP);
  assert.strictEqual(found.state, "closed");
});

// --- create / comment / reopen ---------------------------------------------

test("create: posts the title, body, labels, assignees and milestone", async () => {
  const fetchImpl = mockFetch([
    { method: "POST", match: "/issues", body: { number: 5, html_url: "https://x.test/5" } },
  ]);

  const result = await transport(fetchImpl).create({
    title: "TypeError: boom",
    body: "details",
    labels: ["bug", "auto-reported"],
    assignees: ["alice"],
    milestone: 3,
  });

  assert.deepStrictEqual(result, { issueNumber: 5, url: "https://x.test/5" });

  const sent = fetchImpl.calls[0].body;
  assert.strictEqual(sent.title, "TypeError: boom");
  assert.deepStrictEqual(sent.labels, ["bug", "auto-reported"]);
  assert.deepStrictEqual(sent.assignees, ["alice"]);
  assert.strictEqual(sent.milestone, 3);
});

test("create: omits assignees and milestone when unset", async () => {
  const fetchImpl = mockFetch([
    { method: "POST", match: "/issues", body: { number: 5, html_url: "https://x.test/5" } },
  ]);

  await transport(fetchImpl).create({ title: "t", body: "b", labels: [] });

  const sent = fetchImpl.calls[0].body;
  assert.ok(!("assignees" in sent));
  assert.ok(!("milestone" in sent));
});

test("comment and reopen hit the right endpoints", async () => {
  const fetchImpl = mockFetch([
    { method: "POST", match: "/comments", body: { html_url: "https://x.test/5#c1" } },
    { method: "PATCH", match: "/issues/5", body: { html_url: "https://x.test/5", state: "open" } },
  ]);

  const github = transport(fetchImpl);
  await github.comment(5, "seen again");
  await github.reopen(5);

  assert.strictEqual(fetchImpl.calls[0].body.body, "seen again");
  assert.strictEqual(fetchImpl.calls[1].method, "PATCH");
  assert.strictEqual(fetchImpl.calls[1].body.state, "open");
});

test("newIssueUrl: prefills a link when there is no token", () => {
  const github = createGitHubTransport({ repoUrl: "acme/app" });

  assert.strictEqual(github.canCreate, false);

  const url = github.newIssueUrl({ title: "TypeError: boom", body: "x", labels: ["bug"] });
  assert.ok(url.startsWith("https://github.com/acme/app/issues/new?"));
  assert.ok(url.includes("title=TypeError%3A+boom"));
  assert.ok(url.includes("labels=bug"));
});

// --- failure handling -------------------------------------------------------

test("403 with an exhausted quota is retried, then short-circuited", async () => {
  const sleep = recordingSleep();
  const fetchImpl = mockFetch([
    {
      match: "/search/issues",
      status: 403,
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30),
      },
      body: { message: "API rate limit exceeded" },
    },
  ]);

  const github = transport(fetchImpl, { maxRetries: 1, sleep });

  await assert.rejects(() => github.search(FP), /403/);
  assert.strictEqual(sleep.delays.length, 1, "should have waited once before retrying");
  assert.ok(sleep.delays[0] > 0);

  // The quota is gone; the next call must not spend another request on it.
  const callsBefore = fetchImpl.calls.length;
  await assert.rejects(() => github.search(FP), /rate limited/);
  assert.strictEqual(fetchImpl.calls.length, callsBefore);
});

test("429 honors retry-after", async () => {
  const sleep = recordingSleep();
  const fetchImpl = mockFetch([
    {
      match: "/search/issues",
      times: 1,
      status: 429,
      headers: { "retry-after": "2" },
      body: { message: "slow down" },
    },
    { match: "/search/issues", body: { items: [] } },
  ]);

  await transport(fetchImpl, { maxRetries: 2, sleep }).search(FP);

  assert.deepStrictEqual(sleep.delays, [2000]);
});

test("a wait longer than the cap is abandoned instead of hanging the error path", async () => {
  const sleep = recordingSleep();
  const fetchImpl = mockFetch([
    {
      match: "/search/issues",
      status: 429,
      headers: { "retry-after": "3600" },
      body: { message: "slow down" },
    },
  ]);

  await assert.rejects(
    () => transport(fetchImpl, { maxRetries: 2, sleep, maxRetryDelayMs: 30_000 }).search(FP),
    /429/,
  );
  assert.deepStrictEqual(sleep.delays, [], "should not have waited out an hour");
});

test("5xx is retried and can succeed", async () => {
  const sleep = recordingSleep();
  const fetchImpl = mockFetch([
    { match: "/search/issues", times: 2, status: 502, body: { message: "bad gateway" } },
    { match: "/search/issues", body: { items: [issueItem(3, FP)] } },
  ]);

  const found = await transport(fetchImpl, { maxRetries: 2, sleep }).search(FP);

  assert.strictEqual(found.issueNumber, 3);
  assert.strictEqual(sleep.delays.length, 2);
});

test("404 is not retried", async () => {
  const sleep = recordingSleep();
  const fetchImpl = mockFetch([
    { method: "POST", match: "/issues", status: 404, body: { message: "Not Found" } },
  ]);

  await assert.rejects(
    () => transport(fetchImpl, { maxRetries: 3, sleep }).create({ title: "t", body: "b" }),
    /404/,
  );
  assert.strictEqual(fetchImpl.calls.length, 1);
  assert.deepStrictEqual(sleep.delays, []);
});

test("an offline host produces a retryable transport error", async () => {
  const sleep = recordingSleep();

  await assert.rejects(
    () => transport(offlineFetch(), { maxRetries: 1, sleep }).search(FP),
    /request failed/,
  );
  assert.strictEqual(sleep.delays.length, 1);
});
