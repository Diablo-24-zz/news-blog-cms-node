const fs = require("node:fs");
const path = require("node:path");
const mysql = require("mysql2/promise");
const { loadConfig } = require("../src/config/env");

const DATABASES = ["news_cms", "news_cms_test"];

function assertDatabaseNames(config) {
  if (config.DB_NAME !== DATABASES[0] || config.DB_NAME_TEST !== DATABASES[1]) {
    throw new Error(
      "Database setup is restricted to news_cms and news_cms_test",
    );
  }
  if (!config.DB_NAME_TEST.endsWith("_test")) {
    throw new Error(
      "Refusing to initialize a test database without the _test suffix",
    );
  }
}

async function main() {
  const config = loadConfig();
  assertDatabaseNames(config);

  const reset = process.argv.includes("--reset");
  const connection = await mysql.createConnection({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    timezone: "Z",
    multipleStatements: true,
  });

  try {
    const schema = fs.readFileSync(
      path.join(__dirname, "../sql/schema.sql"),
      "utf8",
    );
    const seed = fs.readFileSync(
      path.join(__dirname, "../sql/seed.sql"),
      "utf8",
    );
    for (const database of DATABASES) {
      if (reset) {
        await connection.query(`DROP DATABASE IF EXISTS \`${database}\``);
      }
      await connection.query(
        `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
      await connection.query(`USE \`${database}\``);
      const [existingTables] = await connection.query(
        "SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = ?",
        [database],
      );
      const expectedTables = new Set([
        "users",
        "categories",
        "tags",
        "posts",
        "post_tags",
        "post_revisions",
        "audit_logs",
      ]);
      if (existingTables.length === 0) {
        await connection.query(schema);
      } else if (
        existingTables.length !== expectedTables.size ||
        existingTables.some((table) => !expectedTables.has(table.TABLE_NAME))
      ) {
        throw new Error(
          `${database} has a partial schema; rerun with --reset to rebuild it`,
        );
      }
      await connection.query(
        seed.replace(/;\s*$/, " ON DUPLICATE KEY UPDATE name = VALUES(name);"),
      );
      process.stdout.write(
        `Initialized ${database}${reset ? " (reset)" : ""}\n`,
      );
    }
  } finally {
    await connection.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    // Never include the connection object or configuration in setup errors.
    process.stderr.write(`Database setup failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { assertDatabaseNames, DATABASES };
