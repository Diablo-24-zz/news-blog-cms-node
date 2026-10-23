const express = require("express");
const Joi = require("joi");
const asyncHandler = require("../utils/asyncHandler");
const validate = require("../middleware/validate");
const { authenticate, requirePasswordChanged } = require("../middleware/auth");
const { authorize } = require("../utils/roles");
const { sendData } = require("../utils/response");
const categoryService = require("../services/categoryService");

const router = express.Router();
const categorySchema = Joi.object({
  name: Joi.string().trim().min(1).max(120).required(),
  slug: Joi.string().trim().max(150).allow(""),
});
const updateSchema = Joi.object({
  name: Joi.string().trim().min(1).max(120),
  slug: Joi.string().trim().max(150).allow(""),
}).min(1);
const idSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
});

router.get(
  "/",
  asyncHandler(async (_req, res) =>
    sendData(res, await categoryService.listCategories()),
  ),
);
router.use(authenticate, requirePasswordChanged, authorize("admin"));

router.post(
  "/",
  validate(categorySchema),
  asyncHandler(async (req, res) =>
    res
      .status(201)
      .json({ data: await categoryService.createCategory(req.user, req.body) }),
  ),
);
router.put(
  "/:id",
  validate(idSchema, "params"),
  validate(updateSchema),
  asyncHandler(async (req, res) =>
    sendData(
      res,
      await categoryService.updateCategory(req.user, req.params.id, req.body),
    ),
  ),
);
router.delete(
  "/:id",
  validate(idSchema, "params"),
  asyncHandler(async (req, res) => {
    await categoryService.deleteCategory(req.user, req.params.id);
    return sendData(res, { deleted: true });
  }),
);

module.exports = router;
