"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { redact, redactDeep, PLACEHOLDER } = require("../src/redact");

// Assembled at runtime rather than written out: a literal in the source is
// indistinguishable from a real leaked credential to a secret scanner, and
// gets the push blocked.
const FAKE_SLACK_TOKEN = ["xoxb", "123456789012", "abcdefghijklmno"].join("-");

/**
 * Each case pairs an input with the substring that must not survive.
 * These are the leaks that make auto-filing to a public repository an
 * incident rather than a convenience.
 */
const SECRETS = [
  {
    name: "JWT",
    input:
      "Auth failed for eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
    leak: "eyJhbGciOiJIUzI1NiJ9",
  },
  {
    name: "GitHub token",
    input: "request failed with token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    leak: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  },
  {
    name: "fine-grained GitHub PAT",
    input: "bad credentials: github_pat_11ABCDEFG0abcdefghij_KLMNOPQRSTUVWXYZ0123456789",
    leak: "github_pat_11ABCDEFG0abcdefghij",
  },
  {
    name: "OpenAI-style key",
    input: "401 from provider using sk-proj-abcdefghijklmnopqrstuvwxyz012345",
    leak: "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
  },
  {
    name: "AWS access key id",
    input: "signature mismatch for AKIAIOSFODNN7EXAMPLE",
    leak: "AKIAIOSFODNN7EXAMPLE",
  },
  {
    name: "Slack token",
    input: `posting to slack with ${FAKE_SLACK_TOKEN}`,
    leak: FAKE_SLACK_TOKEN,
  },
  {
    name: "connection string password",
    input: "connect ECONNREFUSED postgres://admin:hunter2@db.internal:5432/app",
    leak: "hunter2",
  },
  {
    name: "token query parameter",
    input: "GET https://api.internal/v1/users?access_token=s3cr3tvalue&page=2 failed",
    leak: "s3cr3tvalue",
  },
  {
    name: "Authorization header",
    input: "headers: { Authorization: Bearer abcdefghijklmnopqrstuvwxyz }",
    leak: "abcdefghijklmnopqrstuvwxyz",
  },
  {
    name: "assigned password",
    input: 'config mismatch: password="hunter2" was rejected',
    leak: "hunter2",
  },
  {
    name: "JSON-quoted api key",
    input: '{"api_key": "abc123secret", "retries": 2}',
    leak: "abc123secret",
  },
  {
    name: "email address",
    input: "no account for alice.smith@example.com",
    leak: "alice.smith@example.com",
  },
  {
    name: "private key block",
    input:
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz\n-----END RSA PRIVATE KEY-----",
    leak: "MIIEowIBAAKCAQEAxyz",
  },
];

for (const { name, input, leak } of SECRETS) {
  test(`redact: removes ${name}`, () => {
    const output = redact(input);
    assert.ok(!output.includes(leak), `leaked ${name}: ${output}`);
    assert.ok(output.includes(PLACEHOLDER), `no placeholder written for ${name}: ${output}`);
  });
}

test("redact: leaves ordinary text alone", () => {
  const input = "Cannot read properties of undefined (reading 'id') at handleRequest";
  assert.strictEqual(redact(input), input);
});

test("redact: applies user-supplied patterns", () => {
  const output = redact("internal id EMP-99881 not found", {
    patterns: [/EMP-\d+/g],
  });

  assert.ok(!output.includes("EMP-99881"));
  assert.ok(output.includes(PLACEHOLDER));
});

test("redact: a broken user pattern does not break reporting", () => {
  const output = redact("still here", { patterns: [{ pattern: "not-a-regexp" }] });
  assert.strictEqual(output, "still here");
});

test("redact: can be turned off", () => {
  const input = "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  assert.strictEqual(redact(input, { defaults: false, homePaths: false }), input);
});

test("redact: replaces the home directory in stack traces", () => {
  const home = require("node:os").homedir();
  const output = redact(`    at run (${home}/app/index.js:1:1)`);

  assert.ok(!output.includes(home));
  assert.ok(output.includes("~/app/index.js"));
});

test("redactDeep: redacts secret-looking keys whatever the value", () => {
  const output = redactDeep({
    userId: 42,
    password: "hunter2",
    nested: { apiKey: "plainlookingvalue", note: "fine" },
  });

  assert.strictEqual(output.userId, 42);
  assert.strictEqual(output.password, PLACEHOLDER);
  assert.strictEqual(output.nested.apiKey, PLACEHOLDER);
  assert.strictEqual(output.nested.note, "fine");
});

test("redactDeep: walks arrays and stops at a sane depth", () => {
  const output = redactDeep(["alice@example.com", { list: ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"] }]);

  assert.strictEqual(output[0], PLACEHOLDER);
  assert.strictEqual(output[1].list[0], PLACEHOLDER);
});
