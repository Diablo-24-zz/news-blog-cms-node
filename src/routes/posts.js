const express = require("express");
const Joi = require("joi");
const asyncHandler = require("../utils/asyncHandler");
const validate = require("../middleware/validate");
const { authenticate, requirePasswordChanged } = require("../middleware/auth");
const { authorize } = require("../utils/roles");
const { sendData } = require("../utils/response");
const postService = require("../services/postService");

const router = express.Router();

const idParam = Joi.object({
  id: Joi.number().integer().positive().required(),
});
const postFields = {
  title: Joi.string().trim().min(1).max(255),
  content: Joi.string().min(1).required(),
  cover_image: Joi.string()
    .uri({ scheme: ["http", "https"] })
    .max(500)
    .allow(null, ""),
  category_id: Joi.number().integer().positive().allow(null),
  tags: Joi.array().items(Joi.string().trim().min(1).max(80)).max(5),
};
const createSchema = Joi.object({
  ...postFields,
  title: postFields.title.required(),
  content: postFields.content.required(),
});
const updateSchema = Joi.object({
  ...postFields,
  content: Joi.string().min(1),
}).min(1);
const reviewSchema = Joi.object({
  review_comment: Joi.string().trim().min(1).max(5000).required(),
});
const publishSchema = Joi.object({
  publish_at: Joi.string()
    .custom((value, helpers) => {
      if (
        !/(Z|[+-]\d{2}:?\d{2})$/i.test(value) ||
        Number.isNaN(new Date(value).getTime())
      ) {
        return helpers.error("date.iso");
      }
      return value;
    })
    .messages({ "date.iso": "publish_at must be ISO 8601 with a timezone" }),
});
const listSchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(50),
  search: Joi.string().max(255).allow(""),
  status: Joi.string().valid(
    "draft",
    "pending_review",
    "approved",
    "published",
    "archived",
    "rejected",
  ),
  category: Joi.string().max(150),
  author: Joi.number().integer().positive(),
  deleted: Joi.boolean().truthy("true").falsy("false"),
  sort: Joi.string().valid(
    "created_at",
    "updated_at",
    "title",
    "views",
    "published_at",
  ),
  direction: Joi.string().valid("asc", "desc"),
});
const publicListSchema = listSchema
  .fork(["status", "author", "deleted"], (schema) => schema.forbidden())
  .keys({
    tag: Joi.string().max(80),
  });

// Public routes are declared before the protected route middleware.
router.get(
  "/public",
  validate(publicListSchema, "query"),
  asyncHandler(async (req, res) => {
    const result = await postService.listPublic(req.query);
    return sendData(res, result.data, result.pagination);
  }),
);

router.get(
  "/public/:slug",
  asyncHandler(async (req, res) =>
    sendData(res, await postService.getPublicBySlug(req.params.slug)),
  ),
);

router.use(authenticate, requirePasswordChanged);

router.get(
  "/",
  validate(listSchema, "query"),
  asyncHandler(async (req, res) => {
    const result = await postService.listPosts(req.user, req.query);
    return sendData(res, result.data, result.pagination);
  }),
);

router.get(
  "/:id",
  validate(idParam, "params"),
  asyncHandler(async (req, res) => {
    const includeDeleted =
      req.user.role === "admin" || req.user.role === "super_admin";
    return sendData(
      res,
      await postService.findForActor(req.user, req.params.id, includeDeleted),
    );
  }),
);

router.post(
  "/",
  validate(createSchema),
  asyncHandler(async (req, res) => {
    return res
      .status(201)
      .json({ data: await postService.createPost(req.user, req.body) });
  }),
);

router.put(
  "/:id",
  validate(idParam, "params"),
  validate(updateSchema),
  asyncHandler(async (req, res) => {
    return sendData(
      res,
      await postService.updatePost(req.user, req.params.id, req.body),
    );
  }),
);

router.patch(
  "/:id/submit",
  validate(idParam, "params"),
  asyncHandler(async (req, res) =>
    sendData(
      res,
      await postService.transition(req.user, req.params.id, "submit"),
    ),
  ),
);
router.patch(
  "/:id/approve",
  validate(idParam, "params"),
  authorize("editor"),
  asyncHandler(async (req, res) =>
    sendData(
      res,
      await postService.transition(req.user, req.params.id, "approve"),
    ),
  ),
);
router.patch(
  "/:id/reject",
  validate(idParam, "params"),
  authorize("editor"),
  validate(reviewSchema),
  asyncHandler(async (req, res) =>
    sendData(
      res,
      await postService.transition(req.user, req.params.id, "reject", req.body),
    ),
  ),
);
router.patch(
  "/:id/publish",
  validate(idParam, "params"),
  authorize("editor"),
  validate(publishSchema),
  asyncHandler(async (req, res) =>
    sendData(
      res,
      await postService.transition(
        req.user,
        req.params.id,
        "publish",
        req.body,
      ),
    ),
  ),
);
router.patch(
  "/:id/archive",
  validate(idParam, "params"),
  authorize("editor"),
  asyncHandler(async (req, res) =>
    sendData(
      res,
      await postService.transition(req.user, req.params.id, "archive"),
    ),
  ),
);

router.delete(
  "/:id",
  validate(idParam, "params"),
  asyncHandler(async (req, res) => {
    await postService.deletePost(req.user, req.params.id);
    return sendData(res, { deleted: true });
  }),
);

router.post(
  "/:id/restore",
  validate(idParam, "params"),
  authorize("admin"),
  asyncHandler(async (req, res) =>
    sendData(res, await postService.restorePost(req.user, req.params.id)),
  ),
);
router.get(
  "/:id/revisions",
  validate(idParam, "params"),
  asyncHandler(async (req, res) =>
    sendData(res, await postService.listRevisions(req.user, req.params.id)),
  ),
);
router.post(
  "/:id/revisions/:revId/restore",
  validate(
    Joi.object({
      id: Joi.number().integer().positive().required(),
      revId: Joi.number().integer().positive().required(),
    }),
    "params",
  ),
  authorize("editor"),
  asyncHandler(async (req, res) =>
    sendData(
      res,
      await postService.restoreRevision(
        req.user,
        req.params.id,
        req.params.revId,
      ),
    ),
  ),
);

module.exports = router;
