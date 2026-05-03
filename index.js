"use strict";

const { reportError, formatIssue } = require("./src/reporter");
const { init, detach } = require("./src/autoCapture");
const { parseRepoUrl } = require("./src/github");

module.exports = { reportError, formatIssue, init, detach, parseRepoUrl };
