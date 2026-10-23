const { sendError } = require("../utils/response");

function errorHandler(error, _req, res, _next) {
  if (error && error.code === "ER_DUP_ENTRY") {
    return sendError(
      res,
      409,
      "A resource with the same unique value already exists",
      undefined,
      "DUPLICATE",
    );
  }
  if (
    error &&
    (error.code === "ER_ROW_IS_REFERENCED_2" ||
      error.code === "ER_ROW_IS_REFERENCED")
  ) {
    return sendError(
      res,
      409,
      "The resource is still in use",
      undefined,
      "IN_USE",
    );
  }
  const status = Number.isInteger(error && error.status) ? error.status : 500;
  if (status === 500) {
    // A stable error code helps operators trace failures without logging SQL,
    // request bodies, passwords, temporary credentials, or token contents.
    const safeCode = /^[A-Z0-9_]+$/.test(error && error.code)
      ? error.code
      : "INTERNAL_ERROR";
    process.stderr.write(`Request failed (${safeCode})\n`);
  }
  const message = status === 500 ? "Internal server error" : error.message;
  return sendError(res, status, message, error.fields, error.code);
}

function notFoundHandler(_req, _res, next) {
  next({ status: 404, message: "Route not found", code: "NOT_FOUND" });
}

module.exports = { errorHandler, notFoundHandler };
