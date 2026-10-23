const jwt = require("jsonwebtoken");
const { getPool } = require("../config/db");
const { loadConfig } = require("../config/env");
const { unauthorized, forbidden } = require("../utils/errors");

const COOKIE_NAME = "news_cms_token";

async function authenticate(req, _res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return next(unauthorized());
  let payload;
  try {
    payload = jwt.verify(token, loadConfig().JWT_SECRET);
  } catch {
    return next(unauthorized());
  }
  if (!Number.isInteger(payload.tv) || payload.tv < 0) {
    return next(unauthorized());
  }

  try {
    const [rows] = await getPool().query(
      "SELECT id, name, email, role, is_active, must_change_password, token_version, created_at, updated_at FROM users WHERE id = ? LIMIT 1",
      [payload.sub],
    );
    const user = rows[0];
    if (
      !user ||
      !user.is_active ||
      Number(payload.tv) !== Number(user.token_version)
    ) {
      return next(unauthorized());
    }
    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requirePasswordChanged(req, _res, next) {
  if (req.user && req.user.must_change_password) {
    return next(
      forbidden(
        "You must change your temporary password first",
        "PASSWORD_CHANGE_REQUIRED",
      ),
    );
  }
  return next();
}

function setAuthCookie(res, token) {
  const config = loadConfig();
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.COOKIE_SECURE,
    maxAge: 2 * 60 * 60 * 1000,
  });
}

function clearAuthCookie(res) {
  const config = loadConfig();
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.COOKIE_SECURE,
  });
}

module.exports = {
  authenticate,
  requirePasswordChanged,
  setAuthCookie,
  clearAuthCookie,
  COOKIE_NAME,
};
