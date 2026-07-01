const express = require("express");
const { Setting } = require("../models");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

router.get("/packages", asyncHandler(async (_req, res) => {
  const setting = await Setting.findOne({ key: "packages" });
  res.json({ ok: true, packages: setting?.value || null });
}));

module.exports = router;
