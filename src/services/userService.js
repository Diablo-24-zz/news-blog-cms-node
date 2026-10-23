const bcrypt = require("bcrypt");
const crypto = require("node:crypto");
const { getPool, withTransaction } = require("../config/db");
const { isAtLeast } = require("../utils/roles");
const { writeAudit } = require("../utils/audit");
const {
  badRequest,
  conflict,
  forbidden,
  notFound,
} = require("../utils/errors");
const { getPagination, paginationData } = require("../utils/pagination");
const { escapeLike } = require("../utils/search");
const { publicUser } = require("./authService");

const VALID_ROLES = ["writer", "editor", "admin", "super_admin"];
const SUPER_ADMIN_LOCK = "news_cms_active_super_admins";

function temporaryPassword() {
  return crypto.randomBytes(18).toString("base64url");
}

function assertRole(role) {
  if (!VALID_ROLES.includes(role)) {
    throw badRequest("Invalid role", { role: "Unknown role" });
  }
}

function canManageTarget(actor, target) {
  if (actor.id === target.id) {
    throw forbidden("You cannot change your own account role or status");
  }
  if (actor.role === "admin" && !["writer", "editor"].includes(target.role)) {
    throw forbidden("Admins can only manage writers and editors");
  }
  if (!isAtLeast(actor.role, "admin")) {
    throw forbidden("Admin permission is required");
  }
}

async function getUserForUpdate(connection, userId) {
  const [rows] = await connection.query(
    "SELECT id, name, email, password_hash, role, is_active, must_change_password, created_at, updated_at FROM users WHERE id = ? FOR UPDATE",
    [userId],
  );
  if (!rows[0]) throw notFound("User not found");
  return rows[0];
}

async function activeSuperAdminCount(connection) {
  const [rows] = await connection.query(
    "SELECT COUNT(*) AS count FROM users WHERE role = 'super_admin' AND is_active = TRUE",
  );
  return Number(rows[0].count);
}

async function withSuperAdminLock(work) {
  const connection = await getPool().getConnection();
  let lockAcquired = false;
  let transactionStarted = false;
  try {
    // A connection-level lock gives all role/status transactions one global
    // order before their snapshot is created, avoiding reciprocal row locks.
    const [lockRows] = await connection.query(
      "SELECT GET_LOCK(?, 10) AS acquired",
      [SUPER_ADMIN_LOCK],
    );
    if (Number(lockRows[0].acquired) !== 1) {
      throw conflict(
        "Super-admin account updates are busy",
        "SUPER_ADMIN_BUSY",
      );
    }
    lockAcquired = true;
    await connection.beginTransaction();
    transactionStarted = true;
    const result = await work(connection);
    await connection.commit();
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    if (lockAcquired) {
      try {
        await connection.query("SELECT RELEASE_LOCK(?)", [SUPER_ADMIN_LOCK]);
      } catch {
        // Closing the MySQL connection also releases its advisory locks.
      }
    }
    connection.release();
  }
}

async function createUser(actor, input) {
  assertRole(input.role);
  if (actor.role === "admin" && !["writer", "editor"].includes(input.role)) {
    throw forbidden("Admins can only create writers and editors");
  }
  if (!isAtLeast(actor.role, "admin")) {
    throw forbidden("Admin permission is required");
  }

  const password = temporaryPassword();
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await withTransaction(async (connection) => {
    const [insert] = await connection.query(
      `INSERT INTO users
        (name, email, password_hash, role, is_active, must_change_password, created_by)
       VALUES (?, LOWER(?), ?, ?, TRUE, TRUE, ?)`,
      [
        input.name.trim(),
        input.email.trim(),
        passwordHash,
        input.role,
        actor.id,
      ],
    );
    await writeAudit(connection, {
      userId: actor.id,
      action: "user_create",
      entity: "user",
      entityId: insert.insertId,
      details: { email: input.email.trim().toLowerCase(), role: input.role },
    });
    const [rows] = await connection.query(
      "SELECT id, name, email, role, is_active, must_change_password, created_at, updated_at FROM users WHERE id = ?",
      [insert.insertId],
    );
    return rows[0];
  });
  return { user: publicUser(result), temporaryPassword: password };
}

async function listUsers(query) {
  const { page, limit, offset } = getPagination(query);
  const conditions = [];
  const params = [];
  if (query.role) {
    assertRole(query.role);
    conditions.push("role = ?");
    params.push(query.role);
  }
  if (query.active !== undefined) {
    conditions.push("is_active = ?");
    params.push(query.active === "true" || query.active === true ? 1 : 0);
  }
  if (query.search) {
    conditions.push("(name LIKE ? OR email LIKE ?)");
    const search = `%${escapeLike(query.search)}%`;
    params.push(search, search);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [rows] = await getPool().query(
    `SELECT id, name, email, role, is_active, must_change_password, created_at, updated_at
     FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS count FROM users ${where}`,
    params,
  );
  return {
    data: rows.map(publicUser),
    pagination: paginationData(page, limit, Number(countRows[0].count)),
  };
}

async function changeRole(actor, userId, role) {
  assertRole(role);
  const result = await withSuperAdminLock(async (connection) => {
    // The advisory lock is acquired before this transaction, so the active
    // count and target state are read in one serialized order.
    const activeSuperAdmins = await activeSuperAdminCount(connection);
    const target = await getUserForUpdate(connection, userId);
    canManageTarget(actor, target);
    if (actor.role !== "super_admin" && !["writer", "editor"].includes(role)) {
      throw forbidden("Only super admins can assign admin roles");
    }
    if (
      target.role === "super_admin" &&
      role !== "super_admin" &&
      target.is_active &&
      activeSuperAdmins <= 1
    ) {
      throw conflict(
        "The last active super admin cannot be demoted",
        "LAST_SUPER_ADMIN",
      );
    }
    await connection.query("UPDATE users SET role = ? WHERE id = ?", [
      role,
      userId,
    ]);
    await writeAudit(connection, {
      userId: actor.id,
      action: "user_role_change",
      entity: "user",
      entityId: userId,
      details: { from: target.role, to: role },
    });
    return { ...target, role };
  });
  return publicUser(result);
}

async function changeStatus(actor, userId, isActive) {
  if (typeof isActive !== "boolean") {
    throw badRequest("isActive must be a boolean", {
      isActive: "Boolean required",
    });
  }
  const result = await withSuperAdminLock(async (connection) => {
    const activeSuperAdmins = await activeSuperAdminCount(connection);
    const target = await getUserForUpdate(connection, userId);
    canManageTarget(actor, target);
    if (
      !isActive &&
      target.role === "super_admin" &&
      target.is_active &&
      activeSuperAdmins <= 1
    ) {
      throw conflict(
        "The last active super admin cannot be deactivated",
        "LAST_SUPER_ADMIN",
      );
    }
    await connection.query("UPDATE users SET is_active = ? WHERE id = ?", [
      isActive ? 1 : 0,
      userId,
    ]);
    await writeAudit(connection, {
      userId: actor.id,
      action: "user_status_change",
      entity: "user",
      entityId: userId,
      details: { from: Boolean(target.is_active), to: isActive },
    });
    return { ...target, is_active: isActive };
  });
  return publicUser(result);
}

async function resetPassword(actor, userId) {
  const password = temporaryPassword();
  const passwordHash = await bcrypt.hash(password, 12);
  await withTransaction(async (connection) => {
    const target = await getUserForUpdate(connection, userId);
    if (!isAtLeast(actor.role, "admin")) {
      throw forbidden("Admin permission is required");
    }
    if (actor.role === "admin" && !["writer", "editor"].includes(target.role)) {
      throw forbidden("Admins can only reset writer and editor passwords");
    }
    await connection.query(
      "UPDATE users SET password_hash = ?, must_change_password = TRUE, token_version = token_version + 1 WHERE id = ?",
      [passwordHash, userId],
    );
    await writeAudit(connection, {
      userId: actor.id,
      action: "password_reset",
      entity: "user",
      entityId: userId,
    });
  });
  return { temporaryPassword: password };
}

module.exports = {
  createUser,
  listUsers,
  changeRole,
  changeStatus,
  resetPassword,
  VALID_ROLES,
};
