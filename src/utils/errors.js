class AppError extends Error {
  constructor(status, message, code, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

function badRequest(message, fields) {
  return new AppError(400, message, "VALIDATION_ERROR", fields);
}

function unauthorized(message = "Authentication required") {
  return new AppError(401, message, "UNAUTHORIZED");
}

function forbidden(message, code = "FORBIDDEN") {
  return new AppError(403, message, code);
}

function notFound(message = "Resource not found") {
  return new AppError(404, message, "NOT_FOUND");
}

function conflict(message, code = "CONFLICT") {
  return new AppError(409, message, code);
}

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
};
