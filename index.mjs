// ESM entry point.
//
// The implementation stays CommonJS — it is small enough that a build step
// would cost more than it saves — and this wrapper re-exports it so `import`
// and `require` users get the same module instance.

import reporter from "./index.js";

export const install = reporter.install;
export const uninstall = reporter.uninstall;
export const reportError = reporter.reportError;
export const formatIssue = reporter.formatIssue;
export const formatDuplicateComment = reporter.formatDuplicateComment;
export const fingerprint = reporter.fingerprint;
export const fingerprintMarker = reporter.fingerprintMarker;
export const extractFingerprint = reporter.extractFingerprint;
export const redact = reporter.redact;
export const redactionPatterns = reporter.redactionPatterns;
export const createGitHubTransport = reporter.createGitHubTransport;
export const parseRepoUrl = reporter.parseRepoUrl;

/** @deprecated use `install` */
export const init = reporter.init;
/** @deprecated use `uninstall` */
export const detach = reporter.detach;

export default reporter;
