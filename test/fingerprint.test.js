"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  fingerprint,
  normalizeMessage,
  topFrames,
  fingerprintMarker,
  extractFingerprint,
} = require("../src/fingerprint");

function errorWith(message, stack) {
  return { name: "TypeError", message, stack: stack || defaultStack };
}

const defaultStack = [
  "TypeError: boom",
  "    at handleRequest (/srv/app/src/server.js:42:11)",
  "    at Server.emit (node:events:513:28)",
].join("\n");

test("fingerprint: same bug with a different variable name hashes the same", () => {
  const a = errorWith("Cannot read properties of undefined (reading 'userId')");
  const b = errorWith("Cannot read properties of undefined (reading 'orderId')");

  assert.strictEqual(fingerprint(a), fingerprint(b));
});

test("fingerprint: volatile values do not split one bug", () => {
  const cases = [
    ["Timeout after 3000ms", "Timeout after 5120ms"],
    [
      "Record 6f1a2b3c-1111-4222-8333-444455556666 missing",
      "Record 7a2b3c4d-5555-4666-8777-888899990000 missing",
    ],
    ["Cannot open /home/alice/app/data.db", "Cannot open /var/lib/other/data.db"],
    ["Bad pointer 0xdeadbeef", "Bad pointer 0xcafef00d"],
  ];

  for (const [first, second] of cases) {
    assert.strictEqual(
      fingerprint(errorWith(first)),
      fingerprint(errorWith(second)),
      `expected a stable fingerprint for: ${first}`,
    );
  }
});

test("fingerprint: genuinely different errors hash differently", () => {
  const a = errorWith("Cannot read properties of undefined (reading 'id')");
  const b = errorWith("Connection refused");

  assert.notStrictEqual(fingerprint(a), fingerprint(b));
});

test("fingerprint: a different call site hashes differently", () => {
  const a = errorWith("boom");
  const b = errorWith(
    "boom",
    ["TypeError: boom", "    at renderPage (/srv/app/src/render.js:8:3)"].join("\n"),
  );

  assert.notStrictEqual(fingerprint(a), fingerprint(b));
});

test("fingerprint: line numbers moving does not change the hash", () => {
  const before = errorWith(
    "boom",
    ["TypeError: boom", "    at handleRequest (/srv/app/src/server.js:42:11)"].join("\n"),
  );
  const after = errorWith(
    "boom",
    ["TypeError: boom", "    at handleRequest (/srv/app/src/server.js:87:15)"].join("\n"),
  );

  assert.strictEqual(fingerprint(before), fingerprint(after));
});

test("fingerprint: the same deployment path on another machine hashes the same", () => {
  const ci = errorWith(
    "boom",
    ["TypeError: boom", "    at handleRequest (/home/runner/work/app/src/server.js:42:11)"].join("\n"),
  );
  const local = errorWith(
    "boom",
    ["TypeError: boom", "    at handleRequest (/Users/alice/dev/app/src/server.js:42:11)"].join("\n"),
  );

  assert.strictEqual(fingerprint(ci), fingerprint(local));
});

test("fingerprint: stable across repeated calls and 16 hex chars long", () => {
  const error = errorWith("boom");
  assert.strictEqual(fingerprint(error), fingerprint(error));
  assert.match(fingerprint(error), /^[0-9a-f]{16}$/);
});

test("normalizeMessage: replaces quoted values, numbers, paths and ids", () => {
  const normalized = normalizeMessage(
    "Failed 'thing' after 12 tries at /var/data/x with id 0xff",
  );
  assert.strictEqual(normalized, "Failed <value> after <n> tries at <path> with id <hex>");
});

test("topFrames: keeps the requested number of frames", () => {
  const stack = [
    "Error: x",
    "    at a (/app/one.js:1:1)",
    "    at b (/app/two.js:2:2)",
    "    at c (/app/three.js:3:3)",
  ].join("\n");

  assert.deepStrictEqual(topFrames(stack, 2), ["a@app/one.js", "b@app/two.js"]);
});

test("topFrames: tolerates a missing stack", () => {
  assert.deepStrictEqual(topFrames(undefined), []);
});

test("marker: round-trips through an issue body", () => {
  const hash = fingerprint(errorWith("boom"));
  const body = `${fingerprintMarker(hash)}\n\nSome description`;

  assert.strictEqual(extractFingerprint(body), hash);
  assert.strictEqual(extractFingerprint("no marker here"), null);
});
