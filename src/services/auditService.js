const { getPool } = require("../config/db");
const { getPagination, paginationData } = require("../utils/pagination");
const { toIsoUtc } = require("../utils/time");

async function listAuditLogs(query) {
  const { page, limit, offset } = getPagination(query);
  const conditions = [];
  const params = [];
  if (query.action) {
    conditions.push("a.action = ?");
    params.push(query.action);
  }
  if (query.entity) {
    conditions.push("a.entity = ?");
    params.push(query.entity);
  }
  if (query.user_id) {
    conditions.push("a.user_id = ?");
    params.push(Number(query.user_id));
  }
  if (query.from) {
    conditions.push("a.created_at >= ?");
    params.push(new Date(query.from));
  }
  if (query.to) {
    conditions.push("a.created_at <= ?");
    params.push(new Date(query.to));
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [rows] = await getPool().query(
    `SELECT a.id, a.user_id, u.name AS user_name, a.action, a.entity, a.entity_id, a.details, a.created_at
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
      ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS count FROM audit_logs a ${where}`,
    params,
  );
  const data = rows.map((row) => ({
    ...row,
    details:
      typeof row.details === "string" ? JSON.parse(row.details) : row.details,
    created_at: toIsoUtc(row.created_at),
  }));
  return {
    data,
    pagination: paginationData(page, limit, Number(countRows[0].count)),
  };
}

module.exports = { listAuditLogs };
