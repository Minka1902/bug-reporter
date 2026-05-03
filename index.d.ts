export interface ReportOptions {
  /** Full GitHub URL (https://github.com/owner/repo) or short form "owner/repo" */
  repoUrl: string;
  /** GitHub Personal Access Token — enables automatic issue creation */
  token?: string;
  /** Suppress all console output (default: false) */
  silent?: boolean;
  /** Any extra key/value data to attach to the issue body */
  extra?: Record<string, unknown>;
}

export interface ReportResult {
  /** "created" | "existing" | "not_reported" | "error" */
  status: string;
  /** URL of the created or found issue, or a pre-filled new-issue URL */
  url?: string;
  message?: string;
}

export interface InitOptions {
  /** Full GitHub URL or "owner/repo" */
  repoUrl: string;
  /** GitHub PAT */
  token?: string;
  /** Suppress logs */
  silent?: boolean;
  /** Also capture unhandledRejection events (default: true) */
  captureUnhandledRejections?: boolean;
}

/**
 * Manually report a single error to GitHub.
 */
export function reportError(error: Error | unknown, options: ReportOptions): Promise<ReportResult>;

/**
 * Attach global `uncaughtException` / `unhandledRejection` handlers.
 * Call once at application startup.
 */
export function init(options: InitOptions): void;

/** Remove the global handlers (useful in tests). */
export function detach(): void;

/** Parse a GitHub URL into { owner, repo }. */
export function parseRepoUrl(repoUrl: string): { owner: string; repo: string };
