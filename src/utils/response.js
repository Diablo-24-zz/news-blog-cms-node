function sendData(res, data, pagination) {
  if (pagination) return res.json({ data, pagination });
  return res.json({ data });
}

function sendError(res, status, message, fields, code) {
  const error = { message };
  if (fields) error.fields = fields;
  if (code) error.code = code;
  return res.status(status).json({ error });
}

module.exports = { sendData, sendError };
