"use strict";

// Child-process fixture for the crash-semantics tests. Inert unless the test
// runner asks for it, so a bare `node --test` cannot trip over it.
if (process.env.BR_FIXTURE === "1") {
  const fs = require("node:fs");
  const { install } = require("../../index.js");

  install({
    logLevel: "silent",
    exitOnUncaught: process.env.BR_EXIT !== "false",
    transport: {
      canCreate: true,
      async search() {
        return null;
      },
      async create(issue) {
        // Synchronous write: process.exit() would truncate a buffered one.
        fs.writeSync(1, `REPORTED:${issue.title}\n`);
        return { issueNumber: 1, url: "https://example.test/issues/1" };
      },
    },
  });

  if (process.env.BR_MODE === "reject") {
    Promise.reject(new Error("rejected from fixture"));
  } else {
    setTimeout(() => {
      throw new Error("boom from fixture");
    }, 10);
  }

  // Only reached if the process was allowed to keep running.
  setTimeout(() => {
    fs.writeSync(1, "STILL_ALIVE\n");
    process.exit(7);
  }, 500);
}
