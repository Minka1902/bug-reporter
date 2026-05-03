"use strict";

const assert = require("assert");
const { parseRepoUrl } = require("../src/github");
const { formatIssue } = require("../src/reporter");
const { init, detach } = require("../src/autoCapture");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}: ${e.message}`);
    failed++;
  }
}

// --- parseRepoUrl ---
test("parseRepoUrl: https URL", () => {
  const { owner, repo } = parseRepoUrl("https://github.com/alice/my-app");
  assert.strictEqual(owner, "alice");
  assert.strictEqual(repo, "my-app");
});

test("parseRepoUrl: https URL with .git suffix", () => {
  const { owner, repo } = parseRepoUrl("https://github.com/alice/my-app.git");
  assert.strictEqual(owner, "alice");
  assert.strictEqual(repo, "my-app");
});

test("parseRepoUrl: short owner/repo form", () => {
  const { owner, repo } = parseRepoUrl("alice/my-app");
  assert.strictEqual(owner, "alice");
  assert.strictEqual(repo, "my-app");
});

test("parseRepoUrl: throws on invalid URL", () => {
  assert.throws(() => parseRepoUrl("not-a-url"), /Cannot parse/);
});

test("parseRepoUrl: throws when empty", () => {
  assert.throws(() => parseRepoUrl(""), /repoUrl is required/);
});

// --- formatIssue ---
test("formatIssue: title includes error name and message", () => {
  const err = new TypeError("something went wrong");
  const { title } = formatIssue(err);
  assert.ok(title.includes("TypeError"));
  assert.ok(title.includes("something went wrong"));
});

test("formatIssue: body contains stack trace", () => {
  const err = new Error("oops");
  const { body } = formatIssue(err);
  assert.ok(body.includes("Stack Trace"));
  assert.ok(body.includes("oops"));
});

test("formatIssue: title is max 256 chars", () => {
  const err = new Error("x".repeat(300));
  const { title } = formatIssue(err);
  assert.ok(title.length <= 256);
});

// --- autoCapture init / detach ---
test("init: throws without repoUrl", () => {
  assert.throws(() => init({}), /repoUrl is required/);
});

test("init + detach: attaches and removes listeners", () => {
  init({ repoUrl: "alice/test-repo", silent: true });
  const before = process.listenerCount("uncaughtException");
  assert.ok(before >= 1);
  detach();
  assert.strictEqual(process.listenerCount("uncaughtException"), 0);
});

// Summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
