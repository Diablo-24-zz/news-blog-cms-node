async function writeAudit(
  connection,
  { userId, action, entity, entityId, details = {} },
) {
  await connection.query(
    "INSERT INTO audit_logs (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)",
    [userId || null, action, entity, entityId || null, JSON.stringify(details)],
  );
}

module.exports = { writeAudit };
