# 🐞 auto-github-bug-reporter

Catches runtime errors and files them as GitHub issues — deduplicated by fingerprint, redacted by default, and rate-limited so a crash loop cannot spam your tracker.

- **Global handlers** — `install()` wires `uncaughtException` and `unhandledRejection` for you, and preserves Node's crash semantics instead of quietly swallowing them.
- **Deterministic deduplication** — errors are hashed into a fingerprint embedded in the issue body, so the same bug files one issue no matter how the message is worded.
- **Safe by default** — secrets are redacted before anything leaves the process, reports are throttled, and the reporter never throws.
- **Zero runtime dependencies** — native `fetch`, Node 18+.

## Installation

```bash
npm install auto-github-bug-reporter
```

## Quick start

```js
const { install } = require("auto-github-bug-reporter");

install({
  repoUrl: "your-org/your-repo",
  token: process.env.GITHUB_TOKEN, // fine-grained PAT, Issues: read and write
  environments: ["production"],
  cacheFile: ".cache/bug-reporter.json",
});
```

That is the whole setup. Any uncaught exception or unhandled rejection is now fingerprinted, deduplicated and filed.

ESM works the same way:

```js
import { install } from "auto-github-bug-reporter";
```

### Reporting by hand

```js
const { reportError } = require("auto-github-bug-reporter");

try {
  await chargeCard(order);
} catch (error) {
  const result = await reportError(error, {
    repoUrl: "your-org/your-repo",
    token: process.env.GITHUB_TOKEN,
    context: { orderId: order.id },
    tags: ["payments"],
  });

  if (result.status === "created") notifyOnCall(result.url);
}
```

`reportError` returns a promise you can await or ignore. After `install()`, per-call options are optional — the installed configuration is used as the base.

## The result object

```js
{
  status: "created" | "duplicate" | "unreported" | "skipped",
  url,          // issue URL, or a prefilled "new issue" link when unreported
  issueNumber,  // present for created and duplicate
  fingerprint,  // the deduplication hash
  reason,       // why, when status is "skipped"
}
```

| Status | Meaning |
| --- | --- |
| `created` | A new issue was filed. |
| `duplicate` | The fingerprint already had an issue; it was commented on (and reopened if it had been closed). |
| `unreported` | No token, so nothing was filed. `url` is a prefilled link a human can click. |
| `skipped` | Nothing was sent. `reason` is one of `disabled`, `environment`, `sampled`, `before-send`, `throttled`, `rate-limited`, `dry-run`, `no-transport`, `transport-error`, `report-timeout`, `internal-error`. |

## Deduplication

Searching GitHub for the error message is fragile: the same bug with a different variable name in the message files a second issue. Instead, every error is reduced to a **fingerprint**:

1. The message is normalized — numbers, UUIDs, hex addresses, absolute paths and quoted values are replaced with placeholders.
2. The top 5 stack frames are reduced to `function@file`, dropping line and column numbers so an edit above the failing line does not split one bug in two.
3. The result is hashed.

The fingerprint is embedded in the issue body as `<!-- bug-reporter:fp=<hash> -->` and searched for exactly. Candidate matches are verified against the marker rather than trusted, so deduplication is deterministic rather than fuzzy.

A few consequences worth knowing:

- **Every issue state is searched.** A match on a *closed* issue is a regression, so the issue is reopened and commented on rather than filed again. Set `reopenClosed: false` to leave issue state alone.
- **Duplicates are not silent.** Each duplicate posts a comment with the running occurrence count — "Seen 143 times since Aug 3" is far more useful than nothing. Set `commentOnDuplicate: false` to turn that off.
- **A local cache sits in front of the API.** GitHub's search API allows 30 requests/minute authenticated (10 unauthenticated) and is eventually consistent, so a crash loop would exhaust the quota and race its own first report. Set `cacheFile` to persist it, and the protection survives restarts too — which is the case that matters, since a crashing process is usually a restarting process.

Do not edit the HTML comment at the top of a generated issue body; removing it causes the bug to be filed again.

## Safety

### Redaction

Stack traces and error messages leak connection strings, JWTs, `?token=` query parameters, emails and provider API keys. Auto-posting those to a public repository is an incident, so redaction runs **before** anything is hashed, logged or sent.

Built in: JWTs, GitHub tokens (`ghp_`, `github_pat_`), OpenAI/Anthropic-style `sk-` keys, AWS access key IDs, Slack tokens, PEM private key blocks, `Authorization` headers, credentials inside connection strings, secret-looking query parameters and assignments, and email addresses. Values under secret-looking keys in `context` (`password`, `apiKey`, `token`, …) are dropped whatever they contain, and your home directory is replaced with `~` in stack traces.

```js
install({
  repoUrl: "your-org/your-repo",
  token: process.env.GITHUB_TOKEN,
  redactPatterns: [/EMP-\d{5}/g], // your own patterns, applied after the defaults
  beforeSend(report) {
    if (report.context.tenant === "internal") return null; // cancel the report
    report.context.region = process.env.REGION;            // or mutate it
  },
});
```

`beforeSend` runs before the throttle, so a cancelled report costs nothing from the hourly budget. Mutating `report.message` or `report.stack` does not recompute the fingerprint — set `report.fingerprint` yourself if you need to.

### Spam guards

| Option | Default | Effect |
| --- | --- | --- |
| `perFingerprintMs` | 1 hour | The same bug reaches the tracker at most once per window. This also bounds duplicate comments. |
| `maxIssuesPerHour` | 10 | Rolling cap on reports reaching the transport, so a storm of *distinct* errors cannot flood the repo either. |

Suppressed occurrences are still counted, so the number in the next comment stays honest. On 403/429/5xx the transport honors `retry-after` and `x-ratelimit-reset`, backs off exponentially with jitter, and short-circuits further requests while the quota is exhausted rather than hammering from inside an error handler.

### It never throws

An error reporter that crashes the app is worse than no reporter. Every entry point is wrapped: failures resolve as `status: "skipped"` and are passed to `onError` if you want them.

```js
install({ repoUrl: "…", onError: (error) => metrics.increment("bug_reporter.failure") });
```

### Crash semantics

Registering an `uncaughtException` listener silently stops Node from exiting, which leaves the process running in the state Node deliberately aborts on. So by default the handler prints the stack to stderr, reports (with a `reportTimeoutMs` deadline, 3s), and exits 1 — exactly what would have happened without the reporter.

```js
install({ repoUrl: "…", exitOnUncaught: false }); // keep the process alive instead
```

Unhandled rejections follow the same principle: since Node 15 they terminate the process, so the reporter exits too — unless the process was started with `--unhandled-rejections=warn` (or `none`), which it detects. Override with `exitOnUnhandledRejection`.

### Trying it out safely

```js
install({ repoUrl: "…", token: "…", dryRun: true });
```

`dryRun` runs the whole pipeline — fingerprint, redaction, formatting — without filing anything, and returns the issue it would have created as `result.issue`. Combine with `enabled`, `environments: ["production"]` and `sampleRate` for production control.

## GitHub token

A **fine-grained personal access token** with **Issues: read and write** on the target repository is enough. Do not use a classic token with the full `repo` scope: it grants read and write access to all your code, and it will be sitting in a `.env` file inside your error path.

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens.
2. Select the repository, then set **Repository permissions → Issues: Read and write**.
3. Store it as `GITHUB_TOKEN` and load it however you load config.

Without a token nothing is filed: reports come back as `unreported` with a prefilled issue link.

## Issue content

Each issue carries the stack in a code fence, the fingerprint, first/last seen timestamps, occurrence count, source, environment, Node version, OS, arch, your package version, and any `context` and `tags` you passed.

```js
install({
  repoUrl: "…",
  labels: ["bug", "auto-reported"], // default
  assignees: ["alice"],
  milestone: 4,
  context: { service: "checkout" },
  tags: ["backend"],
});
```

Titles are truncated to GitHub's 256-character limit. To change the template entirely:

```js
const { install, formatIssue } = require("auto-github-bug-reporter");

install({
  repoUrl: "…",
  formatIssue(report) {
    const { title, body, labels } = formatIssue(report); // extend the default…
    return { title: `[${report.runtime.environment}] ${title}`, body, labels };
  },
});
```

## Other trackers

The core only ever calls `search` / `create` / `comment` / `reopen`, so anything implementing that interface works — GitLab, Jira, Linear, or a plain webhook:

```js
install({
  transport: {
    canCreate: true,
    async search(fingerprint) {
      const hit = await myTracker.find(fingerprint);
      return hit && { issueNumber: hit.id, url: hit.url, state: hit.state };
    },
    async create(issue) {
      const created = await myTracker.create(issue); // { title, body, labels }
      return { issueNumber: created.id, url: created.url };
    },
    async comment(issueNumber, body) {
      await myTracker.comment(issueNumber, body);
    },
    async reopen(issueNumber) {
      await myTracker.reopen(issueNumber);
    },
  },
});
```

Only `search` and `create` are required. The GitHub adapter is exported as `createGitHubTransport` if you want to wrap it.

## Logging

```js
install({ repoUrl: "…", logLevel: "info" });          // silent | error | info | debug
install({ repoUrl: "…", logger: require("pino")() }); // or plug in your own
```

Anything exposing `error` / `warn` / `info` / `debug` works, so pino and winston drop straight in.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `repoUrl` | `string` | — | `owner/repo` or a GitHub URL. Required unless `transport` is set. |
| `token` | `string` | — | Fine-grained PAT with Issues: read and write. |
| `transport` | `object \| function` | — | Custom tracker adapter. |
| `enabled` | `boolean` | `true` | Master switch. |
| `environments` | `string[]` | all | Only report when `NODE_ENV` is in this list. |
| `sampleRate` | `number` | `1` | Fraction of reports to send. |
| `dryRun` | `boolean` | `false` | Run everything except filing. |
| `fingerprintFrames` | `number` | `5` | Stack frames included in the hash. |
| `commentOnDuplicate` | `boolean` | `true` | Comment when a duplicate is seen. |
| `reopenClosed` | `boolean` | `true` | Reopen a matching closed issue. |
| `cacheFile` | `string` | — | Persist fingerprints and throttle state. |
| `perFingerprintMs` | `number` | `3600000` | Minimum gap between reports of one bug. |
| `maxIssuesPerHour` | `number` | `10` | Rolling cap on reports reaching the transport. |
| `redact` | `boolean \| object` | `true` | Disable or configure redaction. |
| `redactPatterns` | `RegExp[]` | `[]` | Extra patterns applied after the defaults. |
| `redactHomePaths` | `boolean` | `true` | Replace the home directory with `~`. |
| `beforeSend` | `function` | — | Mutate the report, or return `null` to cancel. |
| `onError` | `function` | — | Called with internal failures. |
| `labels` | `string[]` | `["bug", "auto-reported"]` | Issue labels. |
| `assignees` | `string[]` | `[]` | Issue assignees. |
| `milestone` | `number` | — | Milestone number. |
| `formatIssue` | `function` | — | Replace the issue template. |
| `context` | `object` | `{}` | Extra data attached to every issue. |
| `tags` | `string[]` | `[]` | Tags attached to every issue. |
| `logLevel` | `string` | `"error"` | `silent`, `error`, `info` or `debug`. |
| `logger` | `object` | — | Inject pino, winston, etc. |
| `timeoutMs` | `number` | `10000` | Per-request timeout. |
| `maxRetries` | `number` | `2` | Retries on 403/429/5xx and network errors. |
| `fetch` | `function` | global | Inject a fetch implementation. |
| `exitOnUncaught` | `boolean` | `true` | `install()` only. Exit 1 after reporting a crash. |
| `exitOnUnhandledRejection` | `boolean` | follows Node | `install()` only. |
| `reportTimeoutMs` | `number` | `3000` | `install()` only. How long reporting may delay a fatal exit. |
| `captureUnhandledRejections` | `boolean` | `true` | `install()` only. |

## Migrating from v1

| v1 | v2 |
| --- | --- |
| `init(options)` | `install(options)` — `init` still works and warns. |
| `detach()` | `uninstall()` — `detach` still works and warns. Only this package's handlers are removed now. |
| `silent: true` | `logLevel: "silent"` — `silent` still works and warns. |
| `extra: {…}` | `context: {…}` — `extra` still works and warns. |
| `status: "existing" \| "not_reported" \| "error"` | `"duplicate"` / `"unreported"` / `"skipped"` |
| `formatIssue(error, context)` | `formatIssue(report)` |
| Fuzzy message search, open issues only | Fingerprint search across all states |
| An uncaught exception left the process running | Reports, then exits 1 (`exitOnUncaught: false` restores v1 behavior) |
| `node-fetch`, Node ≥ 14 | Native `fetch`, Node ≥ 18, zero dependencies |
| CommonJS only | CommonJS and ESM |

Browser support (`window.onerror` / `unhandledrejection`) is planned for 2.1.

## License

MIT
