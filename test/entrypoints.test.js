"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const EXPORTS = [
  "install",
  "uninstall",
  "reportError",
  "formatIssue",
  "formatDuplicateComment",
  "fingerprint",
  "fingerprintMarker",
  "extractFingerprint",
  "redact",
  "createGitHubTransport",
  "parseRepoUrl",
];

test("the CommonJS entry point exposes the public API", () => {
  const reporter = require("../index.js");

  for (const name of EXPORTS) {
    assert.strictEqual(typeof reporter[name], "function", `${name} should be callable`);
  }
  assert.ok(Array.isArray(reporter.redactionPatterns));
});

test("the ESM entry point exposes the same API", async () => {
  const url = pathToFileURL(path.join(__dirname, "..", "index.mjs")).href;
  const reporter = await import(url);

  for (const name of EXPORTS) {
    assert.strictEqual(typeof reporter[name], "function", `${name} should be exported`);
  }
  assert.strictEqual(typeof reporter.default.install, "function");
});

test("both entry points resolve to the same implementation", async () => {
  const cjs = require("../index.js");
  const esm = await import(pathToFileURL(path.join(__dirname, "..", "index.mjs")).href);

  assert.strictEqual(cjs.reportError, esm.reportError);
});

test("the deprecated v1 aliases still work and warn once", () => {
  const reporter = require("../index.js");
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    const off = reporter.init({
      logLevel: "silent",
      transport: {
        canCreate: true,
        async search() {
          return null;
        },
        async create() {
          return { issueNumber: 1, url: "https://example.test/1" };
        },
      },
    });
    off();
    reporter.detach();
  } finally {
    console.warn = original;
  }

  assert.ok(warnings.some((line) => line.includes("init() is deprecated")));
  assert.ok(warnings.some((line) => line.includes("detach() is deprecated")));
});

test("package.json declares the dual entry points and zero dependencies", () => {
  const pkg = require("../package.json");

  assert.strictEqual(pkg.exports["."].require, "./index.js");
  assert.strictEqual(pkg.exports["."].import, "./index.mjs");
  assert.strictEqual(pkg.exports["."].types, "./index.d.ts");
  assert.strictEqual(pkg.sideEffects, false);
  assert.ok(pkg.engines.node.includes("18"));
  assert.deepStrictEqual(pkg.dependencies, undefined, "the package must stay dependency-free");
});
