const express = require("express");
const { Booking, Invoice, Notification, Setting, User } = require("../models");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get("/users", asyncHandler(async (_req, res) => {
  const users = await User.find().select("-passwordHash").sort({ createdAt: -1 });
  res.json({ ok: true, users });
}));

router.patch("/users/:id", asyncHandler(async (req, res) => {
  const allowed = ["name", "company", "phone", "role", "status", "isEmailVerified"];
  const update = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) update[key] = req.body[key];
  }
  const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select("-passwordHash");
  res.json({ ok: true, user });
}));

router.get("/bookings", asyncHandler(async (_req, res) => {
  const bookings = await Booking.find().populate("user", "name email company").sort({ createdAt: -1 });
  res.json({ ok: true, bookings });
}));

router.patch("/bookings/:id", asyncHandler(async (req, res) => {
  const allowed = ["status", "notes", "services", "hours", "afterHours", "crm", "integrationNotes", "requestedDate", "adminResponse"];
  const update = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) update[key] = req.body[key];
  }
  if (Object.prototype.hasOwnProperty.call(update, "requestedDate")) {
    update.requestedDate = update.requestedDate ? new Date(update.requestedDate) : null;
  }
  if (Object.prototype.hasOwnProperty.call(update, "adminResponse")) {
    update.respondedAt = new Date();
    update.respondedBy = req.user._id;
  }
  const booking = await Booking.findByIdAndUpdate(req.params.id, update, { new: true }).populate("user", "name email company");
  if (booking?.user?._id && (update.adminResponse || update.status)) {
    await Notification.create({
      user: booking.user._id,
      title: "Booking update",
      body: update.adminResponse || `Your booking status is now ${booking.status}.`,
      type: "booking",
    });
  }
  res.json({ ok: true, booking });
}));

router.get("/bills", asyncHandler(async (_req, res) => {
  const bills = await Invoice.find().populate("user", "name email company").sort({ createdAt: -1 });
  res.json({ ok: true, bills });
}));

router.patch("/bills/:id", asyncHandler(async (req, res) => {
  const allowed = ["invoice", "company", "amount", "currency", "status", "dueDate", "lineItems"];
  const update = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) update[key] = req.body[key];
  }
  const bill = await Invoice.findByIdAndUpdate(req.params.id, update, { new: true });
  res.json({ ok: true, bill });
}));

router.post("/settings", asyncHandler(async (req, res) => {
  const entries = Object.entries(req.body || {});
  const saved = [];
  for (const [key, value] of entries) {
    const setting = await Setting.findOneAndUpdate(
      { key },
      { value, updatedBy: req.user._id },
      { upsert: true, new: true }
    );
    saved.push(setting);
  }
  res.json({ ok: true, settings: saved });
}));

module.exports = router;
