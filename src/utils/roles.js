const ROLE_RANKS = Object.freeze({
  writer: 1,
  editor: 2,
  admin: 3,
  super_admin: 4,
});

function isAtLeast(role, minimum) {
  return ROLE_RANKS[role] >= ROLE_RANKS[minimum];
}

function authorize(minimum) {
  return (req, _res, next) => {
    if (!req.user || !isAtLeast(req.user.role, minimum)) {
      return next({
        status: 403,
        message: "You do not have permission to perform this action",
        code: "FORBIDDEN",
      });
    }
    return next();
  };
}

module.exports = { ROLE_RANKS, isAtLeast, authorize };
