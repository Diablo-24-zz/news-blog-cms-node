const path = require("node:path");
const express = require("express");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const morgan = require("morgan");
const { loadConfig } = require("./config/env");
const { createRateLimiters } = require("./middleware/rateLimit");
const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const postRoutes = require("./routes/posts");
const categoryRoutes = require("./routes/categories");
const auditRoutes = require("./routes/audit");

function createApp(options = {}) {
  const config = loadConfig();
  const app = express();
  const rateLimiters = createRateLimiters(
    options.enableRateLimits ?? config.NODE_ENV !== "test",
  );

  if (config.NODE_ENV === "production") app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", "https:", "data:"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );
  if (config.NODE_ENV !== "test") {
    app.use(morgan(config.NODE_ENV === "production" ? "combined" : "dev"));
  }
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/health", (_req, res) => res.json({ data: { status: "ok" } }));
  app.use("/api/auth/login", rateLimiters.login);
  app.use("/api", rateLimiters.api);
  app.use("/api", (req, res, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      return rateLimiters.write(req, res, next);
    }
    return next();
  });
  app.use("/api/auth", authRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/posts", postRoutes);
  app.use("/api/categories", categoryRoutes);
  app.use("/api/audit-logs", auditRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
