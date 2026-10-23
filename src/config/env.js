const Joi = require("joi");
const fs = require("node:fs");
const path = require("node:path");

let cachedConfig;

// Node does not load .env files on its own. Keep this tiny loader dependency-free
// and let explicit process environment values win (important in production).
function loadDotEnv() {
  const filePath = path.resolve(__dirname, "../../.env");
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/,
    );
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
      if (line.includes('"')) {
        value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
      }
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    process.env[match[1]] = value;
  }
}

function loadConfig() {
  if (cachedConfig) return cachedConfig;
  loadDotEnv();

  const schema = Joi.object({
    NODE_ENV: Joi.string()
      .valid("development", "test", "production")
      .default("development"),
    PORT: Joi.number().integer().min(1).max(65535).default(3000),
    DB_HOST: Joi.string().default("127.0.0.1"),
    DB_PORT: Joi.number().integer().min(1).max(65535).default(3306),
    DB_USER: Joi.string().default("news_cms"),
    DB_PASSWORD: Joi.string().allow("").default(""),
    DB_NAME: Joi.string().default("news_cms"),
    DB_NAME_TEST: Joi.string().default("news_cms_test"),
    JWT_SECRET: Joi.string()
      .min(32)
      .custom((value, helpers) => {
        if (/(replace_with|change_me|your_secret)/i.test(value)) {
          return helpers.error("any.invalid");
        }
        return value;
      })
      .messages({
        "any.invalid": '"JWT_SECRET" must not contain a known placeholder',
      })
      .required(),
    COOKIE_SECURE: Joi.boolean().truthy("true").falsy("false").default(false),
    DB_SSL: Joi.boolean().truthy("true").falsy("false").empty("").optional(),
    DB_CA_CERT: Joi.string().trim().allow("").optional(),
  }).unknown(true);

  const { error, value } = schema.validate(process.env, { abortEarly: false });
  if (error) {
    throw new Error(
      `Invalid environment: ${error.details.map((detail) => detail.message).join("; ")}`,
    );
  }

  if (value.NODE_ENV === "test" && !value.DB_NAME_TEST.endsWith("_test")) {
    throw new Error("DB_NAME_TEST must end with _test");
  }
  if (value.NODE_ENV === "production" && !value.COOKIE_SECURE) {
    throw new Error("COOKIE_SECURE must be true in production");
  }
  if (value.DB_SSL === false && value.DB_CA_CERT) {
    throw new Error("DB_SSL=false conflicts with DB_CA_CERT");
  }
  if (
    value.NODE_ENV === "production" &&
    value.DB_SSL === undefined &&
    !value.DB_CA_CERT
  ) {
    throw new Error(
      "In production set DB_SSL=true (or provide DB_CA_CERT). Set DB_SSL=false only if the database is on the same host or a private network.",
    );
  }

  cachedConfig = value;
  return cachedConfig;
}

function resetConfigForTests() {
  cachedConfig = undefined;
}

module.exports = { loadConfig, resetConfigForTests, loadDotEnv };
