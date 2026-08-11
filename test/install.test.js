"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { execFile } = require("node:child_process");

const { install, uninstall } = require("../src/autoCapture");

const FIXTURE = path.join(__dirname, "fixtures", "crash.js");

const noopTransport = {
  canCreate: true,
  async search() {
    return null;
  },
  async create() {
    return { issueNumber: 1, url: "https://example.test/issues/1" };
  },
};

/** Runs the crash fixture and resolves with its exit code and output. */
function runFixture(env = {}, execArgv = []) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...execArgv, FIXTURE],
      { env: { ...process.env, BR_FIXTURE: "1", ...env }, timeout: 15_000 },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof error.code === "number" ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

test("install requires somewhere to report to", () => {
  assert.throws(() => install({}), /requires `repoUrl` or a custom `transport`/);
});

test("install attaches handlers and returns an uninstall function", () => {
  const before = process.listenerCount("uncaughtException");

  const off = install({ transport: noopTransport, logLevel: "silent" });

  assert.strictEqual(typeof off, "function");
  assert.strictEqual(process.listenerCount("uncaughtException"), before + 1);
  assert.strictEqual(process.listenerCount("unhandledRejection"), before + 1);

  off();
  assert.strictEqual(process.listenerCount("uncaughtException"), before);
});

test("uninstall removes only this package's handlers", () => {
  const mine = () => {};
  process.on("uncaughtException", mine);

  install({ transport: noopTransport, logLevel: "silent" });
  uninstall();

  assert.ok(
    process.listeners("uncaughtException").includes(mine),
    "other libraries' handlers must survive",
  );
  process.removeListener("uncaughtException", mine);
});

test("installing twice does not double-attach", () => {
  const before = process.listenerCount("uncaughtException");

  install({ transport: noopTransport, logLevel: "silent" });
  install({ transport: noopTransport, logLevel: "silent" });

  assert.strictEqual(process.listenerCount("uncaughtException"), before + 1);
  uninstall();
});

test("captureUnhandledRejections: false leaves rejections alone", () => {
  const before = process.listenerCount("unhandledRejection");

  install({ transport: noopTransport, logLevel: "silent", captureUnhandledRejections: false });

  assert.strictEqual(process.listenerCount("unhandledRejection"), before);
  uninstall();
});

test("an uncaught exception is reported and still exits 1", async () => {
  const { code, stdout, stderr } = await runFixture();

  assert.ok(stdout.includes("REPORTED:"), "the crash should have been reported");
  assert.strictEqual(code, 1, "Node's crash semantics must be preserved");
  assert.ok(!stdout.includes("STILL_ALIVE"), "the process should not have survived");
  assert.ok(stderr.includes("boom from fixture"), "the stack should still reach stderr");
});

test("exitOnUncaught: false keeps the process alive", async () => {
  const { code, stdout } = await runFixture({ BR_EXIT: "false" });

  assert.ok(stdout.includes("REPORTED:"));
  assert.ok(stdout.includes("STILL_ALIVE"));
  assert.strictEqual(code, 7);
});

test("an unhandled rejection is reported and exits, matching Node's default", async () => {
  const { code, stdout } = await runFixture({ BR_MODE: "reject" });

  assert.ok(stdout.includes("REPORTED:"));
  assert.strictEqual(code, 1);
});

test("a process started with --unhandled-rejections=warn is not killed", async () => {
  const { code, stdout } = await runFixture({ BR_MODE: "reject" }, ["--unhandled-rejections=warn"]);

  assert.ok(stdout.includes("REPORTED:"));
  assert.ok(stdout.includes("STILL_ALIVE"));
  assert.strictEqual(code, 7);
});
