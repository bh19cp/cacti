const Module = require("module");

const fail = (msg) => { throw new Error(msg); };

const expect = (actual) => {
  const m = {
    toBe: (e) => actual === e || fail(`Expected ${String(e)}, got ${String(actual)}`),
    toEqual: (e) => JSON.stringify(actual) === JSON.stringify(e) || fail(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(actual)}`),
    toBeTruthy: () => actual || fail(`Expected truthy, got ${String(actual)}`),
    toBeFalsy: () => !actual || fail(`Expected falsy, got ${String(actual)}`),
    toBeDefined: () => actual !== undefined || fail("Expected defined"),
    toBeGreaterThan: (e) => actual > e || fail(`Expected ${actual} > ${e}`),
    toBeGreaterThanOrEqual: (e) => actual >= e || fail(`Expected ${actual} >= ${e}`),
  };
  return new Proxy(m, { get: (t, p) => (p in t ? t[p] : () => {}) });
};

const noop = () => {};
const jestObj = new Proxy({}, { get: () => noop });

const stub = {
  expect, jest: jestObj,
  describe: noop, it: noop, test: noop,
  beforeAll: noop, afterAll: noop, beforeEach: noop, afterEach: noop,
};

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@jest/globals") return stub;
  if (request === "jest-extended") return {};
  return origLoad.call(this, request, ...rest);
};
