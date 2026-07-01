const express = require("express");
const { Invoice, Notification, Booking } = require("../models");
const { asyncHandler } = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");
const { publicUser } = require("../utils/publicUser");

const router = express.Router();

router.get("/dashboard/profile", requireAuth, asyncHandler(async (req, res) => {
  const bookings = await Booking.countDocuments({ user: req.user._id });
  const invoices = await Invoice.countDocuments({ user: req.user._id });
  const notifications = await Notification.countDocuments({ user: req.user._id, readAt: null });
  res.json({ ok: true, user: publicUser(req.user), stats: { bookings, invoices, notifications } });
}));

router.get("/invoices", requireAuth, asyncHandler(async (req, res) => {
  const filter = req.user.role === "admin" ? {} : { user: req.user._id };
  const invoices = await Invoice.find(filter).sort({ createdAt: -1 });
  res.json({ ok: true, invoices });
}));

router.get("/notifications", requireAuth, asyncHandler(async (req, res) => {
  const filter = req.user.role === "admin" ? {} : { user: req.user._id };
  const notifications = await Notification.find(filter).sort({ createdAt: -1 });
  res.json({ ok: true, notifications });
}));

module.exports = router;
