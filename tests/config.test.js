const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { buildSslOptions } = require("../src/config/db");

const root = path.resolve(__dirname, "..");

function loadConfigInChild(
  overrides = {},
  outputExpression = "String(config.COOKIE_SECURE)",
) {
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
      `const config = require('./src/config/env').loadConfig(); process.stdout.write(${outputExpression})`,
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
    DB_SSL: "false",
    DB_CA_CERT: "",
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

test("database TLS configuration follows production and CA rules", () => {
  const publicCa = loadConfigInChild(
    {
      NODE_ENV: "production",
      COOKIE_SECURE: "true",
      DB_SSL: "true",
      DB_CA_CERT: "",
    },
    "JSON.stringify({ dbSsl: config.DB_SSL ?? null, caSet: Boolean(config.DB_CA_CERT) })",
  );
  assert.equal(publicCa.status, 0, publicCa.stderr);
  assert.equal(publicCa.stdout, '{"dbSsl":true,"caSet":false}');

  const customCa = loadConfigInChild(
    {
      NODE_ENV: "development",
      DB_SSL: "",
      DB_CA_CERT:
        "-----BEGIN CERTIFICATE-----\\nexample\\n-----END CERTIFICATE-----",
    },
    "JSON.stringify({ dbSsl: config.DB_SSL ?? null, caSet: Boolean(config.DB_CA_CERT) })",
  );
  assert.equal(customCa.status, 0, customCa.stderr);
  assert.equal(customCa.stdout, '{"dbSsl":null,"caSet":true}');

  const conflict = loadConfigInChild({
    NODE_ENV: "development",
    DB_SSL: "false",
    DB_CA_CERT: "-----BEGIN CERTIFICATE-----\\nexample",
  });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /DB_SSL=false conflicts with DB_CA_CERT/);

  const missingProductionTls = loadConfigInChild({
    NODE_ENV: "production",
    COOKIE_SECURE: "true",
    DB_SSL: "",
    DB_CA_CERT: "",
  });
  assert.notEqual(missingProductionTls.status, 0);
  assert.match(missingProductionTls.stderr, /In production set DB_SSL=true/);

  const productionOptOut = loadConfigInChild(
    {
      NODE_ENV: "production",
      COOKIE_SECURE: "true",
      DB_SSL: "false",
      DB_CA_CERT: "",
    },
    "String(config.DB_SSL)",
  );
  assert.equal(productionOptOut.status, 0, productionOptOut.stderr);
  assert.equal(productionOptOut.stdout, "false");

  for (const NODE_ENV of ["development", "test"]) {
    const noTls = loadConfigInChild(
      { NODE_ENV, DB_SSL: "", DB_CA_CERT: "" },
      "String(config.DB_SSL)",
    );
    assert.equal(noTls.status, 0, noTls.stderr);
    assert.equal(noTls.stdout, "undefined");
  }
});

test("buildSslOptions returns verified TLS options for supported CA forms", () => {
  assert.equal(
    buildSslOptions({
      NODE_ENV: "development",
      DB_SSL: undefined,
      DB_CA_CERT: "",
    }),
    undefined,
  );
  assert.equal(
    buildSslOptions({ NODE_ENV: "production", DB_SSL: false, DB_CA_CERT: "" }),
    undefined,
  );

  const systemCa = buildSslOptions({
    NODE_ENV: "development",
    DB_SSL: true,
    DB_CA_CERT: "",
  });
  assert.equal(systemCa.rejectUnauthorized, true);
  assert.equal("ca" in systemCa, false);

  const pem = "-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----";
  const pemOptions = buildSslOptions({
    NODE_ENV: "development",
    DB_SSL: undefined,
    DB_CA_CERT: `  ${pem}  `,
  });
  assert.equal(pemOptions.ca, pem);
  assert.equal(pemOptions.rejectUnauthorized, true);

  const escapedPem = String.raw`-----BEGIN CERTIFICATE-----\nexample\n-----END CERTIFICATE-----`;
  const escapedOptions = buildSslOptions({
    NODE_ENV: "test",
    DB_SSL: undefined,
    DB_CA_CERT: escapedPem,
  });
  assert.equal(escapedOptions.ca, pem);
  assert.equal(escapedOptions.rejectUnauthorized, true);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "news-cms-ca-"));
  const caPath = path.join(directory, `ca-${randomUUID()}.pem`);
  try {
    fs.writeFileSync(caPath, pem);
    const fileOptions = buildSslOptions({
      NODE_ENV: "development",
      DB_SSL: undefined,
      DB_CA_CERT: caPath,
    });
    assert.equal(fileOptions.ca, pem);
    assert.equal(fileOptions.rejectUnauthorized, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an unreadable CA path fails without exposing certificate contents", () => {
  const secretText = "PRIVATE-CERTIFICATE-MATERIAL";
  assert.throws(
    () =>
      buildSslOptions({
        NODE_ENV: "development",
        DB_SSL: undefined,
        DB_CA_CERT: path.join(os.tmpdir(), `missing-${randomUUID()}.pem`),
      }),
    (error) =>
      error.message.includes("DB_CA_CERT") &&
      !error.message.includes(secretText),
  );
});

test("source and setup scripts never disable certificate verification", () => {
  function sourceFiles(directory) {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        return entry.isDirectory()
          ? sourceFiles(entryPath)
          : entry.isFile() && entry.name.endsWith(".js")
            ? [entryPath]
            : [];
      });
  }

  const unsafeSetting = ["rejectUnauthorized", "false"].join(": ");
  const matches = [
    ...sourceFiles(path.join(root, "src")),
    ...sourceFiles(path.join(root, "scripts")),
  ].filter((file) => fs.readFileSync(file, "utf8").includes(unsafeSetting));
  assert.deepEqual(matches, []);
});
