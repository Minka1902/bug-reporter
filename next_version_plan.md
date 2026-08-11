# auto-github-bug-reporter — v2.0.0 Plan

This document lays out the plan for the next major version. v2 is a breaking release: it renames parts of the public API, raises the Node floor to 18, and makes safety (redaction, throttling) a default rather than an option.

## Where we are today

An honest gap summary, since the plan below is shaped by it:

- **The README is behind the code.** It documents an older `owner`/`repo`/`silent` manual `try/catch` API, while the code already ships `init()`/`detach()` global handlers (`src/autoCapture.js`) and `reportError()` already returns a promise of `{ status, url, message }` (`src/reporter.js`). The README must be rewritten regardless of everything else here.
- **Deduplication is fuzzy.** `src/github.js` free-text searches the raw error message against **open** issues only. Same bug with a different variable name in the message files a duplicate; closed issues get re-filed; regressions get missed.
- **No safety layer.** Nothing redacts secrets from stack traces before posting them to a (possibly public) repo, nothing throttles a crash loop, and GitHub rate-limit headers are ignored.
- **`node-fetch` is a runtime dependency** for two endpoints, and `package.json` is missing standard metadata.
- **Tests are a hand-rolled runner** with no HTTP mocking and no CI.

## Milestones (in order)

1. **Fingerprinting + deduplication** — the current weakest part.
2. **Safety: redaction, throttling, never-throw** — blocker for any wide adoption; ships before v2 is announced.
3. **API surface** — `install()`, result objects, `logLevel`/`logger`.
4. **Issue quality + `formatIssue` override.**
5. **Transports.**
6. **Hygiene: zero deps, package metadata, CI, provenance, README rewrite.**

---

## 1. API

### `reporter.install()` — global handlers as the headline feature

The README claims the package "detects runtime errors", and that is the feature people actually want — so make it the front door:

- Rename `init()` → `install(options)`; keep `init` as a deprecated alias for one major version. Keep `detach()` (alias `uninstall()`).
- Node: `process.on('uncaughtException')` + `process.on('unhandledRejection')` (already implemented in `src/autoCapture.js`; carried over).
- Browser: `window.onerror` and `window.addEventListener('unhandledrejection', …)` behind environment detection, so the same entry point works in both runtimes.

### Return a result, don't just log

`reportError()` (and every report triggered by `install()`) resolves to:

```js
{
  status: 'created' | 'duplicate' | 'unreported' | 'skipped',
  url,          // issue URL, or pre-filled new-issue URL when unreported
  issueNumber,  // present for created/duplicate
  fingerprint,  // always present
}
```

- Mapping from v1 statuses: `existing` → `duplicate`, `not_reported` → `unreported`, `error` → `skipped` (with the underlying error surfaced via the `onError` callback, see §3).
- Always returns a promise; callers can await it or fire-and-forget. The promise never rejects (see never-throw guarantee, §3).

### Logging

- Replace `silent: boolean` with `logLevel: 'silent' | 'error' | 'info' | 'debug'`.
- Alternatively accept an injected `logger` object (`{ error, warn, info, debug }`) so it plugs directly into pino/winston.
- `silent: true` remains as a deprecated alias for `logLevel: 'silent'`.

## 2. Deduplication

Free-text searching the error message is fragile. Replace it with a deterministic fingerprint:

- **Compute a fingerprint** (`src/fingerprint.js`):
  1. Normalize the message: strip numbers, UUIDs, hex addresses, absolute paths, quoted values.
  2. Take the top N (default 5) stack frames, normalized the same way.
  3. `sha256` the result; use a short prefix (e.g. 16 hex chars) as the fingerprint.
- **Embed it in the issue body** as `<!-- bug-reporter:fp=<hash> -->` and search for that exact string. Deterministic instead of fuzzy.
- **Search `state:all`**, not just open — otherwise closed bugs get re-filed and regressions are silently swallowed as "duplicate".
- **Cache fingerprints locally**: in-memory `Map` plus optional disk persistence. GitHub's search API allows 30 req/min authenticated (10 unauthenticated) and is eventually consistent — a crash loop blows through that in seconds, and the second report races the first. The local cache is consulted before any network call.
- **On duplicate, do something**: post a comment on the existing issue, or bump an occurrence counter in the body ("Seen 143 times since Aug 3"). Far more useful to a maintainer than silence, and it makes `status: 'duplicate'` observable.

## 3. Safety — before wide adoption

### Redaction (`src/redact.js`)

Stack traces and error messages leak connection strings, JWTs, `?token=` query params, emails, `ghp_`/`sk-`/AWS keys. Auto-posting those to a public repo is a real incident.

- Ship default redaction patterns (JWTs, GitHub/OpenAI/AWS key shapes, `://user:pass@` connection strings, token-ish query params, email addresses), applied to title, body, and stack before anything leaves the process.
- Allow user-supplied regexes via `redactPatterns: RegExp[]`.
- Add a `beforeSend(report)` hook that can mutate the payload or return `null`/`false` to cancel the report entirely (→ `status: 'skipped'`).

### Spam guards & rate limits (`src/throttle.js`)

- Per-fingerprint throttle: max 1 report per fingerprint per N minutes (default 60).
- Global `maxIssuesPerHour` cap (default e.g. 10).
- Honor `x-ratelimit-remaining` and `retry-after` response headers; exponential backoff + jitter on 403/429/5xx.

### Never throw

The reporter must never crash the host app — an error reporter that crashes the app is worse than no reporter.

- Every public entry point wrapped; failures are swallowed by default and surfaced via an `onError(err)` callback for anyone who wants them.
- The returned promise resolves (`status: 'skipped'`), never rejects.

### Prod controls

- `dryRun: true` — run the full pipeline (fingerprint, redact, format, log) without filing anything, so config can be verified safely.
- `enabled: boolean`, `environments: ['production']` (matched against `NODE_ENV`), and `sampleRate: 0..1`.

### Token scope

README currently recommends the full `repo` scope. Change the recommendation to a **fine-grained PAT with Issues: read/write only** — over-privileged tokens in `.env` files are a liability.

## 4. Issue quality

Auto-filed issues are only worth having if they're actionable.

- Body template includes: stack trace in a code fence, Node version / OS / arch, host package name+version, reporter version, timestamp (ISO, UTC), occurrence count, fingerprint comment, and any user-supplied `context` and `tags`.
- Options: `labels` (default `['bug', 'auto-reported']`), `assignees`, `milestone`.
- Truncate titles to GitHub's 256-char limit (already done in `formatIssue`; keep).
- Export **`formatIssue(report) => { title, body, labels }`** and accept a user-supplied override, so nobody has to fork the package to change the template.

## 5. Transports

The package is called a bug reporter but is GitHub-only. Introduce a small transport interface:

```js
{
  search(fingerprint) => { url, issueNumber } | null,
  create(issue)       => { url, issueNumber },
  // optional: comment(issueNumber, body) for the duplicate-bump path
}
```

- Built-in GitHub adapter (`src/transports/github.js`) is the default and the only one shipped in v2.
- Core (`fingerprint → redact → throttle → format → transport`) never imports GitHub specifics, so GitLab, Jira, Linear, or a plain webhook can be added — by us or by users — without touching the core. That's the difference between a utility and a package other people build on.

## 6. Hygiene

- **Zero runtime dependencies**: drop `node-fetch`, use native `fetch`, require **Node ≥ 18** (`engines`). "0 deps" is a genuine selling point for something that sits in the error path.
- **`package.json`**: add `files`, `repository`, `bugs`, `homepage`, `sideEffects: false`; keep/expand `keywords`; bump `engines` to `>=18`.
- **CI**: GitHub Actions matrix on Node 18 / 20 / 22, with `nock` (or `msw`) mocking the GitHub API — no live calls in tests. Required coverage:
  - fingerprint stability (same bug, different message details → same hash),
  - redaction of each default pattern,
  - per-fingerprint and global throttle,
  - offline/network-failure path (must resolve `skipped`, never throw),
  - 403/429 path with `retry-after`,
  - no-token path (pre-filled new-issue URL).
- **Publish**: npm provenance on tag via CI.
- **README rewrite** to match the real v2 API: `install()` front and center, result-object usage, safety defaults, fine-grained-PAT instructions, migration notes from v1.

## Proposed module layout

```
index.js                  — public surface: install, uninstall/detach, reportError, formatIssue
index.d.ts                — updated types for everything above
src/reporter.js           — pipeline: fingerprint → redact → throttle → format → transport
src/autoCapture.js        — install()/detach(), Node + browser handler wiring
src/fingerprint.js        — normalize + hash                          (new)
src/redact.js             — default patterns, user patterns           (new)
src/throttle.js           — per-fp throttle, hourly cap, backoff      (new)
src/cache.js              — in-memory Map + optional disk store       (new)
src/transports/github.js  — GitHub adapter (native fetch)             (moved from src/github.js)
test/                     — mocked-API test suite, run in CI matrix
```

## Breaking changes summary (v1 → v2)

| v1 | v2 |
| --- | --- |
| `init(options)` | `install(options)` (`init` deprecated alias) |
| `silent: boolean` | `logLevel` / `logger` (`silent` deprecated alias) |
| statuses `existing` / `not_reported` / `error` | `duplicate` / `unreported` / `skipped` |
| fuzzy message search, open issues | fingerprint search, `state:all` |
| `node-fetch`, Node ≥ 14 | native `fetch`, Node ≥ 18, zero deps |
| full `repo`-scope token in docs | fine-grained PAT, Issues only |
