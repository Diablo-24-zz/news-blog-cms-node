const assert = require("node:assert/strict");
const test = require("node:test");
const { isValidPasswordLength } = require("../src/utils/password");

test("password limits use UTF-8 bytes, not character count", () => {
  assert.equal(isValidPasswordLength("a".repeat(8)), true);
  assert.equal(isValidPasswordLength("a".repeat(72)), true);
  assert.equal(isValidPasswordLength("a".repeat(73)), false);
  assert.equal(isValidPasswordLength("😀".repeat(18)), true);
  assert.equal(isValidPasswordLength("😀".repeat(19)), false);
  assert.equal(isValidPasswordLength("short"), false);
});
