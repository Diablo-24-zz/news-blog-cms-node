const assert = require("node:assert/strict");
const test = require("node:test");
const { assertDatabaseNames } = require("../scripts/setup-databases");
const { DEMO_USERS } = require("../scripts/seed-demo");
const Joi = require("joi");

test("database setup accepts only the development and _test database names", () => {
  assert.doesNotThrow(() =>
    assertDatabaseNames({
      DB_NAME: "news_cms",
      DB_NAME_TEST: "news_cms_test",
    }),
  );
  assert.throws(
    () =>
      assertDatabaseNames({
        DB_NAME: "production",
        DB_NAME_TEST: "news_cms_test",
      }),
    /restricted to news_cms and news_cms_test/,
  );
  assert.throws(
    () =>
      assertDatabaseNames({
        DB_NAME: "news_cms",
        DB_NAME_TEST: "news_cms",
      }),
    /restricted to news_cms and news_cms_test/,
  );
});

test("demo account emails pass the same validator used by the login route", () => {
  for (const [, email] of DEMO_USERS) {
    assert.equal(Joi.string().email().validate(email).error, undefined, email);
  }
});
