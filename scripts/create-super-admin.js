const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const bcrypt = require("bcrypt");
const { getPool, closePool } = require("../src/config/db");
const { loadConfig } = require("../src/config/env");
const { isValidPasswordLength } = require("../src/utils/password");

async function ask(question) {
  const prompt = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

async function main() {
  loadConfig();
  const name = process.env.SUPER_ADMIN_NAME || (await ask("Name: "));
  const email = (process.env.SUPER_ADMIN_EMAIL || (await ask("Email: ")))
    .trim()
    .toLowerCase();
  const password =
    process.env.SUPER_ADMIN_PASSWORD || (await ask("Password (8-72 bytes): "));
  if (!name.trim() || !email || !isValidPasswordLength(password)) {
    throw new Error(
      "Name, email and a password of at least 8 characters and at most 72 UTF-8 bytes are required",
    );
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await getPool().query(
    `INSERT INTO users (name, email, password_hash, role, is_active, must_change_password)
     VALUES (?, ?, ?, 'super_admin', TRUE, FALSE)`,
    [name.trim(), email, passwordHash],
  );
  console.log(`Created super admin ${email}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
