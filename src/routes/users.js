const express = require("express");
const Joi = require("joi");
const asyncHandler = require("../utils/asyncHandler");
const validate = require("../middleware/validate");
const { authenticate, requirePasswordChanged } = require("../middleware/auth");
const { authorize } = require("../utils/roles");
const { sendData } = require("../utils/response");
const userService = require("../services/userService");

const router = express.Router();
router.use(authenticate, requirePasswordChanged, authorize("admin"));

const createSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  email: Joi.string().email().max(255).required(),
  role: Joi.string()
    .valid(...userService.VALID_ROLES)
    .required(),
});
const roleSchema = Joi.object({
  role: Joi.string()
    .valid(...userService.VALID_ROLES)
    .required(),
});
const statusSchema = Joi.object({
  isActive: Joi.boolean(),
  is_active: Joi.boolean(),
}).or("isActive", "is_active");
const listSchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(50),
  role: Joi.string().valid(...userService.VALID_ROLES),
  active: Joi.alternatives().try(
    Joi.boolean(),
    Joi.string().valid("true", "false"),
  ),
  search: Joi.string().max(120).allow(""),
});

router.get(
  "/",
  validate(listSchema, "query"),
  asyncHandler(async (req, res) => {
    const result = await userService.listUsers(req.query);
    return sendData(res, result.data, result.pagination);
  }),
);

router.post(
  "/",
  validate(createSchema),
  asyncHandler(async (req, res) => {
    const result = await userService.createUser(req.user, req.body);
    return res.status(201).json({ data: result });
  }),
);

router.patch(
  "/:id/role",
  validate(roleSchema),
  asyncHandler(async (req, res) => {
    const user = await userService.changeRole(
      req.user,
      Number(req.params.id),
      req.body.role,
    );
    return sendData(res, user);
  }),
);

router.patch(
  "/:id/status",
  validate(statusSchema),
  asyncHandler(async (req, res) => {
    const isActive = req.body.isActive ?? req.body.is_active;
    const user = await userService.changeStatus(
      req.user,
      Number(req.params.id),
      isActive,
    );
    return sendData(res, user);
  }),
);

router.post(
  "/:id/reset-password",
  asyncHandler(async (req, res) => {
    const result = await userService.resetPassword(
      req.user,
      Number(req.params.id),
    );
    return sendData(res, result);
  }),
);

module.exports = router;
