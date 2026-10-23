const { badRequest } = require("../utils/errors");

function validate(schema, source = "body") {
  return (req, _res, next) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false,
      stripUnknown: true,
    });
    if (error) {
      const fields = {};
      error.details.forEach((detail) => {
        fields[detail.path.join(".")] = detail.message;
      });
      return next(badRequest("Request validation failed", fields));
    }
    req[source] = value;
    return next();
  };
}

module.exports = validate;
