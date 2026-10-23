const fs = require("node:fs");
const mysql = require("mysql2/promise");
const { loadConfig } = require("./env");

let pool;

function getPool() {
  if (pool) return pool;
  const config = loadConfig();

  pool = mysql.createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.NODE_ENV === "test" ? config.DB_NAME_TEST : config.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: "Z",
    dateStrings: true,
    ssl: buildSslOptions(config),
  });
  return pool;
}

function buildSslOptions(config) {
  const caSetting = (config.DB_CA_CERT || "").trim();
  if (config.DB_SSL === false && caSetting) {
    throw new Error("DB_SSL=false conflicts with DB_CA_CERT");
  }
  if (
    config.NODE_ENV === "production" &&
    config.DB_SSL === undefined &&
    !caSetting
  ) {
    throw new Error(
      "In production set DB_SSL=true (or provide DB_CA_CERT). Set DB_SSL=false only if the database is on the same host or a private network.",
    );
  }

  if (config.DB_SSL === false || (!config.DB_SSL && !caSetting)) {
    return undefined;
  }
  if (!caSetting) return { rejectUnauthorized: true };

  if (caSetting.startsWith("-----BEGIN")) {
    return {
      ca: caSetting.replace(/\\n/g, "\n"),
      rejectUnauthorized: true,
    };
  }

  try {
    return {
      ca: fs.readFileSync(caSetting, "utf8"),
      rejectUnauthorized: true,
    };
  } catch {
    throw new Error("DB_CA_CERT file path could not be read");
  }
}

async function withTransaction(work) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = { getPool, withTransaction, closePool, buildSslOptions };
