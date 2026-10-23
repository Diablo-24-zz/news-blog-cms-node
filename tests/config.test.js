const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");

function loadConfigInChild(overrides = {}) {
  const env = {
    ...process.env,
    NODE_ENV: "development",
    DB_NAME_TEST: "news_cms_test",
    JWT_SECRET: "safe-test-secret-value-that-is-long-enough",
    ...overrides,
  };
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const config = require('./src/config/env').loadConfig(); process.stdout.write(String(config.COOKIE_SECURE))",
    ],
    { cwd: root, env, encoding: "utf8" },
  );
  return result;
}

test("the example environment leaves JWT_SECRET blank", () => {
  const example = fs.readFileSync(path.join(root, ".env.example"), "utf8");
  assert.match(example, /^JWT_SECRET=\s*$/m);
});

test("JWT_SECRET rejects known placeholders regardless of case", () => {
  for (const placeholder of ["replace_with", "CHANGE_ME", "Your_Secret"]) {
    const result = loadConfigInChild({
      JWT_SECRET: `${"x".repeat(40)}-${placeholder}`,
    });
    assert.notEqual(result.status, 0, `${placeholder} must be rejected`);
  }
});

test("a 32-character non-placeholder JWT_SECRET is accepted", () => {
  const result = loadConfigInChild({ JWT_SECRET: "a".repeat(32) });
  assert.equal(result.status, 0, result.stderr);
});

test("production requires secure cookies", () => {
  const insecure = loadConfigInChild({
    NODE_ENV: "production",
    COOKIE_SECURE: "false",
  });
  assert.notEqual(insecure.status, 0);
  assert.match(insecure.stderr, /COOKIE_SECURE must be true in production/);

  const secure = loadConfigInChild({
    NODE_ENV: "production",
    COOKIE_SECURE: "true",
  });
  assert.equal(secure.status, 0, secure.stderr);
  assert.equal(secure.stdout, "true");
});

test("non-production keeps COOKIE_SECURE false", () => {
  const result = loadConfigInChild({
    NODE_ENV: "development",
    COOKIE_SECURE: "false",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "false");
});
