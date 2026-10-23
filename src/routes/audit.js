const express = require("express");
const Joi = require("joi");
const asyncHandler = require("../utils/asyncHandler");
const validate = require("../middleware/validate");
const { authenticate, requirePasswordChanged } = require("../middleware/auth");
const { authorize } = require("../utils/roles");
const { sendData } = require("../utils/response");
const auditService = require("../services/auditService");

const router = express.Router();
const querySchema = Joi.object({
  page: Joi.number().integer().min(1),
  limit: Joi.number().integer().min(1).max(50),
  action: Joi.string().max(80),
  entity: Joi.string().max(80),
  user_id: Joi.number().integer().positive(),
  from: Joi.string().isoDate(),
  to: Joi.string().isoDate(),
});

router.use(authenticate, requirePasswordChanged, authorize("super_admin"));
router.get(
  "/",
  validate(querySchema, "query"),
  asyncHandler(async (req, res) => {
    const result = await auditService.listAuditLogs(req.query);
    return sendData(res, result.data, result.pagination);
  }),
);

module.exports = router;
