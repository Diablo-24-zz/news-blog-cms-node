const fs = require("node:fs");
const mysql = require("mysql2/promise");
const { loadConfig } = require("./env");

let pool;

function getPool() {
  if (pool) return pool;
  const config = loadConfig();
  const ssl =
    config.NODE_ENV === "production" && config.DB_CA_CERT
      ? {
          ca: fs.readFileSync(config.DB_CA_CERT, "utf8"),
          rejectUnauthorized: true,
        }
      : undefined;

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
    ssl,
  });
  return pool;
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

module.exports = { getPool, withTransaction, closePool };
