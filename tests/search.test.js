const assert = require("node:assert/strict");
const test = require("node:test");
const { escapeLike } = require("../src/utils/search");

test("LIKE search terms escape backslash, percent, and underscore", () => {
  assert.equal(escapeLike(String.raw`a\b%_`), String.raw`a\\b\%\_`);
});
