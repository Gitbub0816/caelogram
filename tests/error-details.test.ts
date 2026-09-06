import test from "node:test";
import assert from "node:assert/strict";
import { errorDetails } from "../cloudflare/errors.js";

test("error diagnostics retain causes but exclude credentials and SDK request objects", () => {
  const cause = new Error("Signing failed with super-secret-value");
  const error = Object.assign(new Error("Bearer abc123 ghp_example", { cause }), {
    request: { headers: { authorization: "should-never-be-serialized" } },
  });
  const result = errorDetails(error, { GITHUB_PRIVATE_KEY: "super-secret-value" });
  assert.equal(result.length, 2);
  const serialized = JSON.stringify(result);
  assert.match(serialized, /Signing failed/);
  for (const value of ["super-secret-value", "abc123", "ghp_example", "should-never-be-serialized"])
    assert.ok(!serialized.includes(value));
});

test("cyclic causes terminate", () => {
  const error = new Error("failure");
  error.cause = error;
  assert.equal(errorDetails(error, {}).length, 1);
});
