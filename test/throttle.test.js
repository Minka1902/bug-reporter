"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Throttle, backoffDelay, retryAfterMs, HOUR_MS } = require("../src/throttle");
const { FingerprintCache } = require("../src/cache");

function clock(start = 1_700_000_000_000) {
  let current = start;
  const now = () => current;
  now.advance = (ms) => {
    current += ms;
  };
  return now;
}

function headers(values) {
  const lower = {};
  for (const [name, value] of Object.entries(values)) lower[name.toLowerCase()] = String(value);
  return { get: (name) => (String(name).toLowerCase() in lower ? lower[String(name).toLowerCase()] : null) };
}

test("throttle: the same fingerprint is reported once per window", () => {
  const now = clock();
  const throttle = new Throttle({ perFingerprintMs: 60_000, maxIssuesPerHour: 0, now });

  assert.strictEqual(throttle.check("abc").allowed, true);
  throttle.record("abc");

  const blocked = throttle.check("abc");
  assert.strictEqual(blocked.allowed, false);
  assert.strictEqual(blocked.reason, "throttled");
  assert.ok(blocked.retryAfterMs > 0);

  // A different bug is unaffected.
  assert.strictEqual(throttle.check("def").allowed, true);

  now.advance(60_001);
  assert.strictEqual(throttle.check("abc").allowed, true);
});

test("throttle: the hourly cap bounds a storm of distinct errors", () => {
  const now = clock();
  const throttle = new Throttle({ perFingerprintMs: 0, maxIssuesPerHour: 3, now });

  for (let i = 0; i < 3; i++) {
    assert.strictEqual(throttle.check(`fp-${i}`).allowed, true);
    throttle.record(`fp-${i}`);
  }

  const blocked = throttle.check("fp-4");
  assert.strictEqual(blocked.allowed, false);
  assert.strictEqual(blocked.reason, "rate-limited");

  now.advance(HOUR_MS + 1);
  assert.strictEqual(throttle.check("fp-4").allowed, true);
});

test("throttle: limits of 0 disable each guard", () => {
  const throttle = new Throttle({ perFingerprintMs: 0, maxIssuesPerHour: 0 });

  for (let i = 0; i < 50; i++) {
    assert.strictEqual(throttle.check("same").allowed, true);
    throttle.record("same");
  }
});

test("throttle: state survives a restart when backed by a cache file", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "br-")), "cache.json");
  const now = clock();

  const first = new FingerprintCache({ file, now });
  const throttleBefore = new Throttle({ perFingerprintMs: HOUR_MS, store: first, now });
  throttleBefore.record("crash-loop");
  first.flush();

  // A crashing process is a restarting process: the guard has to survive it.
  const second = new FingerprintCache({ file, now });
  const throttleAfter = new Throttle({ perFingerprintMs: HOUR_MS, store: second, now });

  assert.strictEqual(throttleAfter.check("crash-loop").allowed, false);
});

test("backoffDelay: grows exponentially and stays capped", () => {
  const options = { baseMs: 100, maxMs: 1000, jitter: false };

  assert.strictEqual(backoffDelay(0, options), 100);
  assert.strictEqual(backoffDelay(1, options), 200);
  assert.strictEqual(backoffDelay(2, options), 400);
  assert.strictEqual(backoffDelay(10, options), 1000);
});

test("backoffDelay: jitter stays inside the window", () => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const delay = backoffDelay(attempt, { baseMs: 100, maxMs: 5000 });
    assert.ok(delay >= 0);
    assert.ok(delay <= Math.min(5000, 100 * 2 ** attempt));
  }
});

test("retryAfterMs: reads retry-after in seconds", () => {
  assert.strictEqual(retryAfterMs(headers({ "retry-after": "12" })), 12_000);
});

test("retryAfterMs: reads retry-after as an HTTP date", () => {
  const now = () => Date.parse("2026-08-11T10:00:00Z");
  const value = retryAfterMs(headers({ "retry-after": "Tue, 11 Aug 2026 10:00:30 GMT" }), now);

  assert.strictEqual(value, 30_000);
});

test("retryAfterMs: falls back to the rate-limit reset when the quota is gone", () => {
  const now = () => 1_700_000_000_000;
  const value = retryAfterMs(
    headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000060" }),
    now,
  );

  assert.strictEqual(value, 60_000);
});

test("retryAfterMs: returns null when the headers say nothing", () => {
  assert.strictEqual(retryAfterMs(headers({ "x-ratelimit-remaining": "42" })), null);
  assert.strictEqual(retryAfterMs(null), null);
});

test("cache: counts every occurrence and remembers the linked issue", () => {
  const now = clock();
  const cache = new FingerprintCache({ now });

  assert.strictEqual(cache.touch("abc").count, 1);
  assert.strictEqual(cache.touch("abc").count, 2);

  cache.link("abc", { issueNumber: 7, url: "https://example.test/7", state: "open" });
  assert.strictEqual(cache.get("abc").issueNumber, 7);
  assert.strictEqual(cache.get("abc").count, 2);
});

test("cache: prunes the oldest entries past the limit", () => {
  const now = clock();
  const cache = new FingerprintCache({ maxEntries: 3, now });

  for (let i = 0; i < 5; i++) {
    cache.touch(`fp-${i}`);
    now.advance(10);
  }

  assert.strictEqual(cache.entries.size, 3);
  assert.strictEqual(cache.get("fp-0"), null);
  assert.ok(cache.get("fp-4"));
});

test("cache: a corrupt cache file is ignored rather than fatal", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "br-")), "cache.json");
  fs.writeFileSync(file, "{ this is not json");

  const cache = new FingerprintCache({ file });

  assert.strictEqual(cache.get("abc"), null);
  assert.strictEqual(cache.touch("abc").count, 1);
});

test("cache: an unwritable path is not fatal", () => {
  // A regular file cannot become a directory, so the write fails on every
  // platform — and must still not throw into the error path.
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "br-")), "blocker");
  fs.writeFileSync(blocker, "");

  const cache = new FingerprintCache({ file: path.join(blocker, "nested", "cache.json") });

  cache.touch("abc");
  cache.flush();
  assert.strictEqual(cache.get("abc").count, 1);
});
