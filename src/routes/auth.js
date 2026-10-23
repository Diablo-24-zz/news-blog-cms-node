const express = require("express");
const Joi = require("joi");
const asyncHandler = require("../utils/asyncHandler");
const validate = require("../middleware/validate");
const {
  authenticate,
  clearAuthCookie,
  requirePasswordChanged,
  setAuthCookie,
} = require("../middleware/auth");
const { sendData } = require("../utils/response");
const authService = require("../services/authService");

const router = express.Router();
const loginSchema = Joi.object({
  email: Joi.string().email().max(255).required(),
  password: Joi.string().min(8).required(),
});
const passwordSchema = Joi.object({
  currentPassword: Joi.string().min(8).required(),
  newPassword: Joi.string().min(8).required(),
});

router.post(
  "/login",
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.login(req.body.email, req.body.password);
    setAuthCookie(res, result.token);
    return sendData(res, result.user);
  }),
);

router.get("/me", authenticate, (req, res) => sendData(res, req.user));

router.post("/logout", (_req, res) => {
  clearAuthCookie(res);
  return sendData(res, { loggedOut: true });
});

router.post(
  "/change-password",
  authenticate,
  validate(passwordSchema),
  asyncHandler(async (req, res) => {
    await authService.changePassword(
      req.user.id,
      req.body.currentPassword,
      req.body.newPassword,
    );
    return sendData(res, { changed: true });
  }),
);

// This middleware is exported for protected route groups. Keeping the three
// account-maintenance endpoints above available is what lets a new user recover.
router.use(requirePasswordChanged);

module.exports = router;
