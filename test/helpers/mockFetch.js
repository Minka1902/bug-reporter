"use strict";

/**
 * Minimal fetch double.
 *
 * The package ships zero dependencies and uses native fetch, so the suite
 * injects an implementation rather than pulling in an HTTP interception
 * library. Nothing here touches the network.
 */
function makeResponse({ status = 200, body = {}, headers = {} }) {
  const lower = {};
  for (const [name, value] of Object.entries(headers)) {
    lower[name.toLowerCase()] = String(value);
  }

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        return key in lower ? lower[key] : null;
      },
    },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

/**
 * @param {Array<{
 *   method?: string,
 *   match?: string,
 *   times?: number,
 *   status?: number,
 *   body?: object,
 *   headers?: object,
 *   throw?: Error|string,
 * }>} routes Matched in order; the first match wins.
 */
function mockFetch(routes = []) {
  const remaining = routes.map((route) => ({ ...route }));
  const calls = [];

  async function fetchImpl(url, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    const call = {
      url: String(url),
      method,
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers || {},
    };
    calls.push(call);

    for (const route of remaining) {
      if (route.method && route.method.toUpperCase() !== method) continue;
      if (route.match && !call.url.includes(route.match)) continue;
      if (route.times !== undefined) {
        if (route.times <= 0) continue;
        route.times -= 1;
      }
      if (route.throw) {
        throw route.throw instanceof Error ? route.throw : new Error(String(route.throw));
      }
      return makeResponse(route);
    }

    throw new Error(`unexpected request: ${method} ${call.url}`);
  }

  fetchImpl.calls = calls;
  fetchImpl.callsTo = (needle) => calls.filter((call) => call.url.includes(needle));
  return fetchImpl;
}

/** A fetch that always fails, standing in for an offline host. */
function offlineFetch() {
  return mockFetch([{ throw: new Error("getaddrinfo ENOTFOUND api.github.com") }]);
}

/** Collects the delays a transport would have slept for, without sleeping. */
function recordingSleep() {
  const delays = [];
  const sleep = async (ms) => {
    delays.push(ms);
  };
  sleep.delays = delays;
  return sleep;
}

module.exports = { mockFetch, makeResponse, offlineFetch, recordingSleep };
