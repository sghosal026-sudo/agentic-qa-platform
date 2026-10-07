import assert from "node:assert/strict";

/** `assert.throws`, but it hands back the error so the test can look inside it. */
export function throwing<T extends Error>(action: () => unknown, type: new (...args: never[]) => T): T {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof type, `expected ${type.name}, got ${String(error)}`);
    return error;
  }
  assert.fail(`expected ${type.name} to be thrown, but nothing was`);
}
