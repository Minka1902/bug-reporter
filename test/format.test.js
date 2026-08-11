"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { formatIssue, formatDuplicateComment, TITLE_LIMIT } = require("../src/format");
const { fingerprintMarker } = require("../src/fingerprint");

function report(overrides = {}) {
  return {
    fingerprint: "a1b2c3d4e5f60718",
    name: "TypeError",
    message: "Cannot read properties of undefined (reading 'id')",
    stack: "TypeError: boom\n    at handleRequest (/srv/app/src/server.js:42:11)",
    timestamp: "2026-08-11T12:00:00.000Z",
    firstSeen: "2026-08-03T09:30:00.000Z",
    occurrenceCount: 143,
    source: "uncaughtException",
    context: { requestId: "req-1", route: "/checkout" },
    tags: ["payments", "api"],
    runtime: {
      node: "v22.0.0",
      platform: "linux",
      arch: "x64",
      os: "Linux 6.1.0",
      environment: "production",
      package: "my-app@1.2.3",
      reporter: "auto-github-bug-reporter@2.0.0",
    },
    labels: ["bug", "auto-reported"],
    ...overrides,
  };
}

test("title carries the error name and message", () => {
  const { title } = formatIssue(report());

  assert.ok(title.startsWith("TypeError: Cannot read properties of undefined"));
});

test("title is truncated to GitHub's 256-character limit", () => {
  const { title } = formatIssue(report({ message: "x".repeat(400) }));

  assert.strictEqual(title.length, TITLE_LIMIT);
  assert.ok(title.endsWith("…"));
});

test("title uses only the first line of a multi-line message", () => {
  const { title } = formatIssue(report({ message: "first line\nsecond line" }));

  assert.strictEqual(title, "TypeError: first line");
});

test("body carries everything a maintainer would otherwise have to ask for", () => {
  const data = report();
  const { body, labels } = formatIssue(data);

  // Deduplication depends on this marker.
  assert.ok(body.startsWith(fingerprintMarker(data.fingerprint)));

  assert.ok(body.includes("```text"), "stack should be in a code fence");
  assert.ok(body.includes("at handleRequest"));

  assert.ok(body.includes("| **Occurrences** | 143 |"));
  assert.ok(body.includes("| **First seen** | 2026-08-03T09:30:00.000Z |"));
  assert.ok(body.includes("| **Last seen** | 2026-08-11T12:00:00.000Z |"));
  assert.ok(body.includes("uncaughtException"));

  assert.ok(body.includes("v22.0.0"));
  assert.ok(body.includes("Linux 6.1.0"));
  assert.ok(body.includes("x64"));
  assert.ok(body.includes("my-app@1.2.3"));
  assert.ok(body.includes("production"));

  assert.ok(body.includes("req-1"), "context should be included");
  assert.ok(body.includes("`payments`"), "tags should be included");

  assert.deepStrictEqual(labels, ["bug", "auto-reported"]);
});

test("body omits empty context and tags", () => {
  const { body } = formatIssue(report({ context: {}, tags: [] }));

  assert.ok(!body.includes("### Context"));
  assert.ok(!body.includes("### Tags"));
});

test("body survives a report with almost nothing in it", () => {
  const { title, body } = formatIssue({ fingerprint: "abc", name: "Error", message: "" });

  assert.strictEqual(title, "Error: unknown error");
  assert.ok(body.includes(fingerprintMarker("abc")));
});

test("duplicate comment reports the running count", () => {
  const comment = formatDuplicateComment(report());

  assert.ok(comment.includes("143 occurrences"));
  assert.ok(comment.includes("2026-08-03T09:30:00.000Z"));
  assert.ok(comment.includes("a1b2c3d4e5f60718"));
  assert.ok(comment.includes("<details>"), "the stack should be collapsed");
});

test("duplicate comment says so when the issue was reopened", () => {
  const comment = formatDuplicateComment(report({ reopened: true }));

  assert.ok(comment.includes("reopening as a regression"));
});

test("duplicate comment handles a single occurrence grammatically", () => {
  const comment = formatDuplicateComment(report({ occurrenceCount: 1 }));

  assert.ok(comment.includes("**1 occurrence**"), comment);
});
