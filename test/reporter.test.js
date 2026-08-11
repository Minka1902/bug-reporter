"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { reportError } = require("../src/reporter");
const { FingerprintCache } = require("../src/cache");
const { Throttle } = require("../src/throttle");
const { createGitHubTransport } = require("../src/transports/github");
const { fingerprintMarker, fingerprint: computeFingerprint } = require("../src/fingerprint");
const { mockFetch, offlineFetch, recordingSleep } = require("./helpers/mockFetch");

const CREATED = { number: 42, html_url: "https://github.com/acme/app/issues/42" };

/**
 * An error with a fixed stack.
 *
 * Two `new Error()` calls in one test function do not share a stack — the one
 * after an `await` resumes on a different frame — so tests that depend on two
 * occurrences of the *same* bug have to pin the stack themselves.
 */
function bug(message = "crash loop") {
  const error = new TypeError(message);
  error.stack = [
    `TypeError: ${message}`,
    "    at handleRequest (/srv/app/src/server.js:42:11)",
    "    at Server.emit (node:events:513:28)",
  ].join("\n");
  return error;
}

/** The fingerprint the pipeline will compute for {@link bug}. */
function fingerprintOf(error) {
  return computeFingerprint(error);
}

/** Isolated per-test state: no shared cache or throttle bleeding between cases. */
function options(overrides = {}) {
  const cache = overrides.cache || new FingerprintCache();
  return {
    logLevel: "silent",
    cache,
    throttle: new Throttle({ store: cache, perFingerprintMs: 0, maxIssuesPerHour: 0 }),
    ...overrides,
  };
}

function github(fetchImpl, overrides = {}) {
  return createGitHubTransport({
    repoUrl: "acme/app",
    token: "test-token",
    fetch: fetchImpl,
    sleep: recordingSleep(),
    maxRetries: 0,
    ...overrides,
  });
}

function existingIssue(fingerprint, state = "open", number = 7) {
  return {
    items: [
      {
        number,
        state,
        html_url: `https://github.com/acme/app/issues/${number}`,
        body: `${fingerprintMarker(fingerprint)}\n\nfirst report`,
      },
    ],
  };
}

// --- happy path -------------------------------------------------------------

test("files an issue when the bug is new", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", body: { items: [] } },
    { method: "POST", match: "/issues", body: CREATED },
  ]);

  const result = await reportError(
    new TypeError("boom"),
    options({ transport: github(fetchImpl) }),
  );

  assert.strictEqual(result.status, "created");
  assert.strictEqual(result.issueNumber, 42);
  assert.strictEqual(result.url, CREATED.html_url);
  assert.match(result.fingerprint, /^[0-9a-f]{16}$/);

  const sent = fetchImpl.callsTo("/repos/acme/app/issues")[0].body;
  assert.ok(sent.title.startsWith("TypeError: boom"));
  assert.ok(sent.body.includes(fingerprintMarker(result.fingerprint)));
  assert.ok(sent.body.includes("### Stack trace"));
  assert.ok(sent.body.includes("### Runtime"));
  assert.deepStrictEqual(sent.labels, ["bug", "auto-reported"]);
});

test("a report always resolves with a fingerprint the caller can branch on", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", body: { items: [] } },
    { method: "POST", match: "/issues", body: CREATED },
  ]);

  const result = await reportError(new Error("boom"), options({ transport: github(fetchImpl) }));

  assert.deepStrictEqual(Object.keys(result).sort(), [
    "fingerprint",
    "issueNumber",
    "status",
    "url",
  ]);
});

// --- deduplication ----------------------------------------------------------

test("comments instead of filing again when the fingerprint already exists", async () => {
  const error = bug("dedupe me");
  const hash = fingerprintOf(error);

  const fetchImpl = mockFetch([
    { match: "/search/issues", body: existingIssue(hash) },
    { method: "POST", match: "/comments", body: { html_url: "https://x.test/7#c1" } },
  ]);

  const result = await reportError(error, options({ transport: github(fetchImpl) }));

  assert.strictEqual(result.status, "duplicate");
  assert.strictEqual(result.issueNumber, 7);
  assert.strictEqual(fetchImpl.callsTo("/comments").length, 1);
  assert.strictEqual(
    fetchImpl.calls.filter((call) => call.url.endsWith("/repos/acme/app/issues")).length,
    0,
    "must not file a second issue",
  );

  const comment = fetchImpl.callsTo("/comments")[0].body.body;
  assert.ok(comment.includes("Seen again"));
  assert.ok(comment.includes(hash));
});

test("reopens a closed issue — a match on a closed bug is a regression", async () => {
  const error = bug("regression");

  const fetchImpl = mockFetch([
    { match: "/search/issues", body: existingIssue(fingerprintOf(error), "closed", 9) },
    { method: "PATCH", match: "/issues/9", body: { html_url: "https://x.test/9", state: "open" } },
    { method: "POST", match: "/comments", body: { html_url: "https://x.test/9#c1" } },
  ]);

  const result = await reportError(error, options({ transport: github(fetchImpl) }));

  assert.strictEqual(result.status, "duplicate");

  const patch = fetchImpl.calls.find((call) => call.method === "PATCH");
  assert.ok(patch, "expected the closed issue to be reopened");
  assert.strictEqual(patch.body.state, "open");

  const comment = fetchImpl.callsTo("/comments")[0].body.body;
  assert.ok(comment.includes("reopening as a regression"));
});

test("reopenClosed: false leaves issue state to the maintainer", async () => {
  const error = bug("stay closed");

  const fetchImpl = mockFetch([
    { match: "/search/issues", body: existingIssue(fingerprintOf(error), "closed", 9) },
    { method: "POST", match: "/comments", body: { html_url: "https://x.test/9#c1" } },
  ]);

  const result = await reportError(
    error,
    options({ transport: github(fetchImpl), reopenClosed: false }),
  );

  assert.strictEqual(result.status, "duplicate");
  assert.strictEqual(fetchImpl.calls.filter((call) => call.method === "PATCH").length, 0);
});

test("the second occurrence skips the search API entirely", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", times: 1, body: { items: [] } },
    { method: "POST", match: "/comments", body: { html_url: "https://x.test/42#c1" } },
    { method: "POST", match: "/issues", body: CREATED },
  ]);

  const shared = options({ transport: github(fetchImpl) });

  const first = await reportError(bug(), shared);
  const second = await reportError(bug(), shared);

  assert.strictEqual(first.status, "created");
  assert.strictEqual(second.status, "duplicate");
  assert.strictEqual(second.issueNumber, 42);
  assert.strictEqual(
    fetchImpl.callsTo("/search/issues").length,
    1,
    "GitHub search is 30 req/min — the local cache must absorb the loop",
  );
});

test("a failing search does not stop the report", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", status: 500, body: { message: "server error" } },
    { method: "POST", match: "/issues", body: CREATED },
  ]);
  const seen = [];

  const result = await reportError(
    new Error("boom"),
    options({ transport: github(fetchImpl), onError: (error) => seen.push(error) }),
  );

  assert.strictEqual(result.status, "created");
  assert.strictEqual(seen.length, 1);
});

// --- no credentials ---------------------------------------------------------

test("without a token it returns a prefilled link instead of failing", async () => {
  const fetchImpl = mockFetch([{ match: "/search/issues", body: { items: [] } }]);

  const result = await reportError(
    new Error("boom"),
    options({ transport: github(fetchImpl, { token: null }) }),
  );

  assert.strictEqual(result.status, "unreported");
  assert.ok(result.url.startsWith("https://github.com/acme/app/issues/new?"));
  assert.strictEqual(fetchImpl.calls.filter((call) => call.method === "POST").length, 0);
});

test("no transport at all is reported, not thrown", async () => {
  const result = await reportError(new Error("boom"), options());

  assert.strictEqual(result.status, "skipped");
  assert.strictEqual(result.reason, "no-transport");
});

// --- the reporter must never throw -----------------------------------------

test("an offline host degrades to skipped", async () => {
  const seen = [];
  const result = await reportError(
    new Error("boom"),
    options({ transport: github(offlineFetch()), onError: (error) => seen.push(error) }),
  );

  assert.strictEqual(result.status, "skipped");
  assert.strictEqual(result.reason, "transport-error");
  assert.ok(seen.length >= 1);
});

test("a transport that throws synchronously cannot crash the app", async () => {
  const result = await reportError(
    new Error("boom"),
    options({
      transport: {
        canCreate: true,
        search() {
          throw new Error("transport exploded");
        },
        create() {
          throw new Error("transport exploded");
        },
      },
    }),
  );

  assert.strictEqual(result.status, "skipped");
});

test("a broken custom formatIssue falls back to the default template", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", body: { items: [] } },
    { method: "POST", match: "/issues", body: CREATED },
  ]);

  const result = await reportError(
    new Error("boom"),
    options({
      transport: github(fetchImpl),
      formatIssue() {
        throw new Error("bad template");
      },
    }),
  );

  assert.strictEqual(result.status, "created");
  assert.ok(fetchImpl.callsTo("/repos/acme/app/issues")[0].body.body.includes("### Stack trace"));
});

test("non-Error values are reported too", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", body: { items: [] } },
    { method: "POST", match: "/issues", body: CREATED },
  ]);

  const result = await reportError("just a string", options({ transport: github(fetchImpl) }));

  assert.strictEqual(result.status, "created");
  assert.ok(fetchImpl.callsTo("/repos/acme/app/issues")[0].body.title.includes("just a string"));
});

// --- spam guards ------------------------------------------------------------

test("the same bug is reported once per throttle window", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", body: { items: [] } },
    { method: "POST", match: "/issues", body: CREATED },
  ]);

  const cache = new FingerprintCache();
  const config = {
    logLevel: "silent",
    cache,
    throttle: new Throttle({ store: cache, perFingerprintMs: 60_000, maxIssuesPerHour: 0 }),
    transport: github(fetchImpl),
  };

  const first = await reportError(bug("loop"), config);
  const second = await reportError(bug("loop"), config);

  assert.strictEqual(first.status, "created");
  assert.strictEqual(second.status, "skipped");
  assert.strictEqual(second.reason, "throttled");

  // Suppressed reports still count, so the occurrence total stays honest.
  assert.strictEqual(cache.get(second.fingerprint).count, 2);
});

test("the hourly cap stops a storm of distinct errors", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", body: { items: [] } },
    { method: "POST", match: "/issues", body: CREATED },
  ]);

  const cache = new FingerprintCache();
  const config = {
    logLevel: "silent",
    cache,
    throttle: new Throttle({ store: cache, perFingerprintMs: 0, maxIssuesPerHour: 2 }),
    transport: github(fetchImpl),
  };

  const results = [];
  for (let i = 0; i < 4; i++) {
    results.push(await reportError(new Error(`distinct error ${i}`), config));
  }

  assert.deepStrictEqual(
    results.map((result) => result.status),
    ["created", "created", "skipped", "skipped"],
  );
  assert.strictEqual(results[3].reason, "rate-limited");
});

// --- production controls ----------------------------------------------------

test("dryRun verifies configuration without filing anything", async () => {
  const fetchImpl = mockFetch([]);

  const result = await reportError(
    new Error("boom"),
    options({ transport: github(fetchImpl), dryRun: true }),
  );

  assert.strictEqual(result.status, "skipped");
  assert.strictEqual(result.reason, "dry-run");
  assert.ok(result.issue.title.includes("boom"));
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test("enabled, environments and sampleRate gate reporting", async () => {
  const fetchImpl = mockFetch([]);
  const transport = github(fetchImpl);

  const disabled = await reportError(new Error("x"), options({ transport, enabled: false }));
  assert.strictEqual(disabled.reason, "disabled");

  const wrongEnvironment = await reportError(
    new Error("x"),
    options({ transport, environments: ["production"] }),
  );
  assert.strictEqual(wrongEnvironment.reason, "environment");

  const sampledOut = await reportError(new Error("x"), options({ transport, sampleRate: 0 }));
  assert.strictEqual(sampledOut.reason, "sampled");

  assert.strictEqual(fetchImpl.calls.length, 0);
});

// --- safety -----------------------------------------------------------------

test("secrets in the error never reach the issue body", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", body: { items: [] } },
    { method: "POST", match: "/issues", body: CREATED },
  ]);

  await reportError(
    new Error("auth failed for postgres://admin:hunter2@db.internal:5432/app"),
    options({
      transport: github(fetchImpl),
      context: { requestId: "abc", apiKey: "sk-live-abcdefghijklmnopqrstuvwx" },
    }),
  );

  const sent = JSON.stringify(fetchImpl.callsTo("/repos/acme/app/issues")[0].body);
  assert.ok(!sent.includes("hunter2"));
  assert.ok(!sent.includes("sk-live-abcdefghijklmnopqrstuvwx"));
  assert.ok(sent.includes("[redacted]"));
  assert.ok(sent.includes("abc"), "non-secret context should survive");
});

test("beforeSend can cancel a report before it costs anything", async () => {
  const fetchImpl = mockFetch([]);

  const result = await reportError(
    new Error("ignore me"),
    options({ transport: github(fetchImpl), beforeSend: () => null }),
  );

  assert.strictEqual(result.status, "skipped");
  assert.strictEqual(result.reason, "before-send");
  assert.strictEqual(fetchImpl.calls.length, 0);
});

test("beforeSend can mutate the payload", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", body: { items: [] } },
    { method: "POST", match: "/issues", body: CREATED },
  ]);

  await reportError(
    new Error("boom"),
    options({
      transport: github(fetchImpl),
      beforeSend(report) {
        report.context = { ...report.context, tenant: "acme" };
        report.labels = ["bug", "triage"];
      },
    }),
  );

  const sent = fetchImpl.callsTo("/repos/acme/app/issues")[0].body;
  assert.ok(sent.body.includes("tenant"));
  assert.deepStrictEqual(sent.labels, ["bug", "triage"]);
});

test("a cancelled report does not consume the hourly budget", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", body: { items: [] } },
    { method: "POST", match: "/issues", body: CREATED },
  ]);

  const cache = new FingerprintCache();
  const throttle = new Throttle({ store: cache, perFingerprintMs: 0, maxIssuesPerHour: 1 });
  const config = { logLevel: "silent", cache, throttle, transport: github(fetchImpl) };

  await reportError(new Error("noise"), { ...config, beforeSend: () => null });
  const kept = await reportError(new Error("real problem"), config);

  assert.strictEqual(kept.status, "created");
});

// --- customization ----------------------------------------------------------

test("a custom transport needs only search and create", async () => {
  const created = [];

  const result = await reportError(
    new Error("boom"),
    options({
      transport: {
        canCreate: true,
        async search() {
          return null;
        },
        async create(issue) {
          created.push(issue);
          return { issueNumber: 1, url: "https://gitlab.example/issues/1" };
        },
      },
    }),
  );

  assert.strictEqual(result.status, "created");
  assert.strictEqual(result.url, "https://gitlab.example/issues/1");
  assert.strictEqual(created.length, 1);
});

test("formatIssue can be replaced wholesale", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", body: { items: [] } },
    { method: "POST", match: "/issues", body: CREATED },
  ]);

  await reportError(
    new Error("boom"),
    options({
      transport: github(fetchImpl),
      formatIssue: (report) => ({
        title: `custom: ${report.name}`,
        body: `fingerprint ${report.fingerprint}`,
        labels: ["custom"],
      }),
    }),
  );

  const sent = fetchImpl.callsTo("/repos/acme/app/issues")[0].body;
  assert.strictEqual(sent.title, "custom: Error");
  assert.deepStrictEqual(sent.labels, ["custom"]);
});

test("labels, assignees and milestone are configurable", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", body: { items: [] } },
    { method: "POST", match: "/issues", body: CREATED },
  ]);

  await reportError(
    new Error("boom"),
    options({
      transport: github(fetchImpl),
      labels: ["crash"],
      assignees: ["alice"],
      milestone: 4,
    }),
  );

  const sent = fetchImpl.callsTo("/repos/acme/app/issues")[0].body;
  assert.deepStrictEqual(sent.labels, ["crash"]);
  assert.deepStrictEqual(sent.assignees, ["alice"]);
  assert.strictEqual(sent.milestone, 4);
});

test("the deprecated silent option still works", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", body: { items: [] } },
    { method: "POST", match: "/issues", body: CREATED },
  ]);
  const warnings = [];

  const result = await reportError(new Error("boom"), {
    ...options({ transport: github(fetchImpl) }),
    logLevel: undefined,
    silent: true,
    logger: { warn: (message) => warnings.push(String(message)) },
  });

  assert.strictEqual(result.status, "created");
  assert.ok(warnings.some((message) => message.includes("`silent` is deprecated")));
});

test("the deprecated extra option is folded into context", async () => {
  const fetchImpl = mockFetch([
    { match: "/search/issues", body: { items: [] } },
    { method: "POST", match: "/issues", body: CREATED },
  ]);

  await reportError(
    new Error("boom"),
    options({ transport: github(fetchImpl), extra: { legacyField: "still-here" } }),
  );

  assert.ok(
    fetchImpl.callsTo("/repos/acme/app/issues")[0].body.body.includes("still-here"),
  );
});
