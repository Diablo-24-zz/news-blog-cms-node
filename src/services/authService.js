const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { getPool, withTransaction } = require("../config/db");
const { loadConfig } = require("../config/env");
const { writeAudit } = require("../utils/audit");
const { unauthorized, badRequest } = require("../utils/errors");
const { toIsoUtc } = require("../utils/time");

// This is used for unknown emails so that the timing of a failed login is similar
// to the timing of a known email with a wrong password.
const DUMMY_PASSWORD_HASH =
  "$2b$12$0fomeTvt6rqs2datHptLNuYg89/NNnIHSmvlIWuSKwbB7f2S.VY2a";

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    is_active: Boolean(user.is_active),
    must_change_password: Boolean(user.must_change_password),
    created_at: toIsoUtc(user.created_at),
    updated_at: toIsoUtc(user.updated_at),
  };
}

async function login(email, password) {
  const [rows] = await getPool().query(
    "SELECT id, name, email, password_hash, role, is_active, must_change_password, created_at, updated_at FROM users WHERE email = ? LIMIT 1",
    [email.toLowerCase()],
  );
  const user = rows[0];
  const passwordMatches = await bcrypt.compare(
    password,
    user ? user.password_hash : DUMMY_PASSWORD_HASH,
  );
  if (!user || !user.is_active || !passwordMatches) {
    throw unauthorized("Invalid email or password");
  }

  const token = jwt.sign({ sub: String(user.id) }, loadConfig().JWT_SECRET, {
    expiresIn: "2h",
  });
  await withTransaction((connection) =>
    writeAudit(connection, {
      userId: user.id,
      action: "login",
      entity: "user",
      entityId: user.id,
    }),
  );
  return { token, user: publicUser(user) };
}

async function changePassword(userId, currentPassword, newPassword) {
  const [rows] = await getPool().query(
    "SELECT id, password_hash FROM users WHERE id = ? LIMIT 1",
    [userId],
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
    throw unauthorized("Current password is incorrect");
  }
  if (currentPassword === newPassword) {
    throw badRequest(
      "New password must be different from the current password",
      { newPassword: "Must be different" },
    );
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await withTransaction(async (connection) => {
    await connection.query(
      "UPDATE users SET password_hash = ?, must_change_password = FALSE WHERE id = ?",
      [passwordHash, userId],
    );
    await writeAudit(connection, {
      userId,
      action: "password_change",
      entity: "user",
      entityId: userId,
    });
  });
}

module.exports = { login, changePassword, publicUser, DUMMY_PASSWORD_HASH };
