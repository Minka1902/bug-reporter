/** Outcome of a report. */
export type ReportStatus = "created" | "duplicate" | "unreported" | "skipped";

/** Why a report was skipped. */
export type SkipReason =
  | "disabled"
  | "environment"
  | "sampled"
  | "before-send"
  | "throttled"
  | "rate-limited"
  | "dry-run"
  | "no-transport"
  | "transport-error"
  | "report-timeout"
  | "internal-error";

export interface ReportResult {
  /** What happened. `skipped` covers everything that did not reach the tracker. */
  status: ReportStatus;
  /** Issue URL, or a prefilled "new issue" link when `status` is `unreported`. */
  url?: string;
  /** Present for `created` and `duplicate`. */
  issueNumber?: number;
  /** Deterministic hash identifying this bug. Absent only on internal failure. */
  fingerprint?: string;
  /** Set when `status` is `skipped`. */
  reason?: SkipReason;
  /** The issue that would have been filed. Only set for `dry-run`. */
  issue?: FormattedIssue;
}

export interface RuntimeInfo {
  node: string;
  platform: string;
  arch: string;
  os: string;
  environment: string;
  /** Host application as `name@version`, when resolvable. */
  package: string | null;
  /** This package as `name@version`. */
  reporter: string;
}

/** The payload handed to `beforeSend` and `formatIssue`. */
export interface Report {
  fingerprint: string;
  name: string;
  /** Redacted. */
  message: string;
  /** Redacted. */
  stack: string;
  /** The original Error object. */
  error: Error;
  /** ISO timestamp of this occurrence. */
  timestamp: string;
  /** ISO timestamp of the first occurrence known locally. */
  firstSeen: string;
  /** Total occurrences seen locally, including throttled ones. */
  occurrenceCount: number;
  source: "manual" | "uncaughtException" | "unhandledRejection" | string;
  context: Record<string, unknown>;
  tags: string[];
  runtime: RuntimeInfo;
  labels: string[];
  assignees: string[];
  milestone: number | null;
  /** Set when a closed issue was reopened for this occurrence. */
  reopened?: boolean;
}

export interface FormattedIssue {
  title: string;
  body: string;
  labels: string[];
}

export interface IssueSearchResult {
  issueNumber: number;
  url: string;
  state: "open" | "closed" | string;
  body?: string;
}

/**
 * Minimal interface a tracker adapter has to satisfy. Implement it to report
 * to GitLab, Jira, Linear or a plain webhook.
 */
export interface Transport {
  name?: string;
  /** False when the transport can only produce a link (e.g. no token). */
  canCreate?: boolean;
  search?(fingerprint: string): Promise<IssueSearchResult | null>;
  create(issue: FormattedIssue & { assignees?: string[]; milestone?: number | null }): Promise<{
    issueNumber: number;
    url: string;
  }>;
  comment?(issueNumber: number, body: string): Promise<unknown>;
  reopen?(issueNumber: number): Promise<unknown>;
  newIssueUrl?(issue: FormattedIssue): string;
}

export interface Logger {
  error?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
  info?(...args: unknown[]): void;
  debug?(...args: unknown[]): void;
}

export type LogLevel = "silent" | "error" | "info" | "debug";

/** A user-supplied redaction rule. */
export type RedactionPattern =
  | RegExp
  | { pattern: RegExp; replace?: string | ((...args: string[]) => string); name?: string };

export interface Options {
  /** GitHub URL or `owner/repo`. Required unless `transport` is given. */
  repoUrl?: string;
  /** Fine-grained PAT with Issues: read and write. Without it, reports resolve to `unreported`. */
  token?: string;
  /** Custom transport instance, or a factory receiving the resolved config. */
  transport?: Transport | ((config: Record<string, unknown>) => Transport);

  /** Master switch. Default: true. */
  enabled?: boolean;
  /** Only report when `NODE_ENV` is in this list. Default: all environments. */
  environments?: string[];
  /** Fraction of reports to send, 0–1. Default: 1. */
  sampleRate?: number;
  /** Run the whole pipeline without filing anything. Default: false. */
  dryRun?: boolean;

  /** Stack frames included in the fingerprint. Default: 5. */
  fingerprintFrames?: number;
  /** Comment on an existing issue when a duplicate is seen. Default: true. */
  commentOnDuplicate?: boolean;
  /** Reopen a matching closed issue — it is a regression. Default: true. */
  reopenClosed?: boolean;
  /** Persist the fingerprint cache here so dedup and throttling survive restarts. */
  cacheFile?: string | null;

  /** Minimum gap between reports of one fingerprint, ms. Default: 1 hour. */
  perFingerprintMs?: number;
  /** Rolling cap on reports reaching the transport per hour. Default: 10. */
  maxIssuesPerHour?: number;

  /** Disable redaction entirely (not recommended) or configure it. Default: true. */
  redact?: boolean | { defaults?: boolean; patterns?: RedactionPattern[] };
  /** Extra redaction patterns, applied after the defaults. */
  redactPatterns?: RedactionPattern[];
  /** Replace the home directory with `~` in stacks. Default: true. */
  redactHomePaths?: boolean;
  /** Inspect or mutate the report; return null/false to cancel it. */
  beforeSend?: (report: Report) => Report | void | null | false | Promise<Report | void | null | false>;
  /** Called with any internal failure. The reporter itself never throws. */
  onError?: (error: Error) => void;

  /** Default: ["bug", "auto-reported"]. */
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
  /** Replace the issue template. */
  formatIssue?: (report: Report) => FormattedIssue;
  /** Extra key/value data attached to every issue. */
  context?: Record<string, unknown>;
  tags?: string[];

  /** Default: "error". */
  logLevel?: LogLevel;
  /** Inject pino, winston, or anything with error/warn/info/debug. */
  logger?: Logger;

  /** Per-request timeout, ms. Default: 10000. */
  timeoutMs?: number;
  /** Retries on 403/429/5xx and network errors. Default: 2. */
  maxRetries?: number;
  /** Override the API base URL. */
  apiBase?: string;
  /** Inject a fetch implementation (tests, proxies, custom agents). */
  fetch?: typeof fetch;

  /** @deprecated use `logLevel` or `logger`. */
  silent?: boolean;
  /** @deprecated use `context`. */
  extra?: Record<string, unknown>;
}

export interface InstallOptions extends Options {
  /** Exit 1 after reporting an uncaught exception, as Node would. Default: true. */
  exitOnUncaught?: boolean;
  /** Exit after an unhandled rejection. Default: follows Node's own mode. */
  exitOnUnhandledRejection?: boolean;
  /** How long reporting may delay a fatal exit, ms. Default: 3000. */
  reportTimeoutMs?: number;
  /** Also capture `unhandledRejection`. Default: true. */
  captureUnhandledRejections?: boolean;
}

/**
 * Attaches global error handlers. Call once at startup.
 * Returns the uninstall function.
 */
export function install(options: InstallOptions): () => void;

/** Removes the handlers installed by this package. */
export function uninstall(): void;

/** Reports a single error. Never throws and never rejects. */
export function reportError(error: unknown, options?: Options): Promise<ReportResult>;

/** The default issue template. */
export function formatIssue(report: Report): FormattedIssue;

/** The default "seen again" comment template. */
export function formatDuplicateComment(report: Report): string;

/** Computes the deduplication fingerprint for an error. */
export function fingerprint(
  error: { name?: string; message?: string; stack?: string },
  options?: { frames?: number; length?: number },
): string;

/** The HTML comment embedded in issue bodies. */
export function fingerprintMarker(hash: string): string;

/** Reads a fingerprint back out of an issue body. */
export function extractFingerprint(body: string): string | null;

/** Applies redaction to a string. */
export function redact(
  text: string,
  options?: { patterns?: RedactionPattern[]; defaults?: boolean; homePaths?: boolean },
): string;

/** The built-in redaction rules. */
export const redactionPatterns: Array<{ name: string; pattern: RegExp }>;

/** Builds the GitHub adapter. */
export function createGitHubTransport(options: {
  repoUrl: string;
  token?: string;
  fetch?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
  maxRetries?: number;
  logger?: Logger;
}): Transport & { owner: string; repo: string };

/** Parses a GitHub URL or `owner/repo` into its parts. */
export function parseRepoUrl(repoUrl: string): { owner: string; repo: string };

/** @deprecated use `install`. */
export function init(options: InstallOptions): () => void;

/** @deprecated use `uninstall`. */
export function detach(): void;
