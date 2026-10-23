const rateLimit = require("express-rate-limit");

function createRateLimiters(enabled) {
  const skip = () => !enabled;
  return {
    login: rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip,
    }),
    api: rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 300,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip,
    }),
    write: rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 60,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      skip,
    }),
  };
}

module.exports = { createRateLimiters };
