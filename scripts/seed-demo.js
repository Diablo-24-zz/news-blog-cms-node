const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const { getPool, closePool } = require("../src/config/db");
const { loadConfig } = require("../src/config/env");

const DEMO_USERS = [
  ["Demo Writer", "writer@example.com", "writer"],
  ["Demo Editor", "editor@example.com", "editor"],
  ["Demo Admin", "admin@example.com", "admin"],
  ["Demo Super Admin", "superadmin@example.com", "super_admin"],
];

async function main() {
  loadConfig();
  const pool = getPool();
  const generated = [];
  for (const [name, email, role] of DEMO_USERS) {
    const password = crypto.randomBytes(18).toString("base64url");
    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, is_active, must_change_password)
       VALUES (?, ?, ?, ?, TRUE, TRUE)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
      [name, email, hash, role],
    );
    if (result.affectedRows === 1) generated.push({ email, password });
  }
  console.log(
    "Demo credentials (shown once; they are not stored in plain text):",
  );
  generated.forEach(({ email, password }) =>
    console.log(`${email}: ${password}`),
  );
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    })
    .finally(() => closePool().catch(() => {}));
}

module.exports = { DEMO_USERS };
