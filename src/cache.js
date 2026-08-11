"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_SAVE_INTERVAL_MS = 1000;

/**
 * Local record of what has already been seen and reported.
 *
 * This is what keeps a crash loop off the network. GitHub's search API allows
 * 30 requests/minute authenticated (10 unauthenticated) and is eventually
 * consistent, so a process failing in a tight loop would both exhaust the quota
 * and race its own first report. Every lookup consults this cache first.
 *
 * Persisting to disk extends the protection across restarts, which is the case
 * that matters most: a crashing process is usually a restarting process.
 *
 * Doubles as the throttle's backing store so both survive together.
 */
class FingerprintCache {
  /**
   * @param {object} [options]
   * @param {string|null} [options.file] Path to persist to. Memory-only when null.
   * @param {number} [options.maxEntries=500]
   * @param {number} [options.ttlMs] Entries older than this are dropped on load.
   * @param {number} [options.saveIntervalMs=1000] Minimum gap between disk writes.
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    this.file = options.file || null;
    this.maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
    this.ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
    this.saveIntervalMs =
      options.saveIntervalMs === undefined ? DEFAULT_SAVE_INTERVAL_MS : options.saveIntervalMs;
    this.now = options.now || Date.now;

    this.entries = new Map();
    this.sends = [];
    this._lastSave = 0;
    this._dirty = false;

    if (this.file) this.load();
  }

  /**
   * Records another occurrence of a fingerprint and returns its entry.
   * Called for every error, including ones the throttle will drop, so the
   * occurrence count reflects reality rather than only what was filed.
   *
   * @param {string} fingerprint
   * @param {number} [timestamp]
   * @returns {{count:number, firstSeen:number, lastSeen:number, issueNumber?:number, url?:string, state?:string, lastReportedAt?:number}}
   */
  touch(fingerprint, timestamp = this.now()) {
    const existing = this.entries.get(fingerprint);
    const entry = existing || { count: 0, firstSeen: timestamp };

    entry.count += 1;
    entry.lastSeen = timestamp;

    this.entries.set(fingerprint, entry);
    this._prune();
    this._touchDisk();
    return entry;
  }

  /** @returns {object|null} */
  get(fingerprint) {
    return this.entries.get(fingerprint) || null;
  }

  /**
   * Remembers which issue a fingerprint resolved to, so later occurrences skip
   * the search API entirely.
   */
  link(fingerprint, { issueNumber, url, state } = {}) {
    const entry = this.entries.get(fingerprint) || {
      count: 1,
      firstSeen: this.now(),
      lastSeen: this.now(),
    };

    if (issueNumber !== undefined) entry.issueNumber = issueNumber;
    if (url !== undefined) entry.url = url;
    if (state !== undefined) entry.state = state;

    this.entries.set(fingerprint, entry);
    this._touchDisk(true);
    return entry;
  }

  // --- throttle store interface ---

  /** Marks a fingerprint as having reached the transport. */
  setReported(fingerprint, timestamp = this.now()) {
    const entry = this.entries.get(fingerprint) || {
      count: 1,
      firstSeen: timestamp,
      lastSeen: timestamp,
    };
    entry.lastReportedAt = timestamp;
    this.entries.set(fingerprint, entry);

    this.sends.push(timestamp);
    this._touchDisk(true);
  }

  /** When this fingerprint last reached the transport, or 0. */
  getReportedAt(fingerprint) {
    const entry = this.entries.get(fingerprint);
    return (entry && entry.lastReportedAt) || 0;
  }

  /** Timestamps of recent sends, used for the hourly cap. */
  getSends(sinceTimestamp) {
    this.sends = this.sends.filter((ts) => ts >= sinceTimestamp);
    return this.sends;
  }

  // --- persistence ---

  /** Best-effort load; a corrupt or unreadable file is simply ignored. */
  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const data = JSON.parse(raw);
      const cutoff = this.ttlMs > 0 ? this.now() - this.ttlMs : 0;

      for (const [fingerprint, entry] of Object.entries(data.entries || {})) {
        if (entry && entry.lastSeen >= cutoff) this.entries.set(fingerprint, entry);
      }
      this.sends = (data.sends || []).filter((ts) => ts >= cutoff);
      this._prune();
    } catch {
      // No cache yet, unreadable, or corrupt — start empty.
    }
  }

  /**
   * Writes the cache to disk synchronously.
   *
   * Synchronous on purpose: the uncaught-exception path exits the process
   * immediately after reporting, and an async write would be lost.
   */
  flush() {
    if (!this.file || !this._dirty) return;

    try {
      const payload = JSON.stringify({
        version: 1,
        entries: Object.fromEntries(this.entries),
        sends: this.sends,
      });

      fs.mkdirSync(path.dirname(this.file), { recursive: true });

      const temporary = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, payload);
      fs.renameSync(temporary, this.file);

      this._dirty = false;
      this._lastSave = this.now();
    } catch {
      // Disk problems must never break reporting.
    }
  }

  _touchDisk(force = false) {
    if (!this.file) return;
    this._dirty = true;
    if (force || this.now() - this._lastSave >= this.saveIntervalMs) this.flush();
  }

  _prune() {
    if (this.entries.size <= this.maxEntries) return;

    const sorted = [...this.entries.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    const excess = this.entries.size - this.maxEntries;
    for (let i = 0; i < excess; i++) this.entries.delete(sorted[i][0]);
  }
}

module.exports = { FingerprintCache, DEFAULT_MAX_ENTRIES, DEFAULT_TTL_MS };
