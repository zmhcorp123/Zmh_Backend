const express = require("express");
const { Booking, Invoice, Notification, Setting, User } = require("../models");
const { sendEmail } = require("../config/email");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get("/users", asyncHandler(async (_req, res) => {
  const users = await User.find().select("-passwordHash").sort({ createdAt: -1 });
  res.json({ ok: true, users });
}));

router.get("/approvals", asyncHandler(async (_req, res) => {
  const users = await User.find({ status: "pending" }).select("-passwordHash").sort({ createdAt: -1 });
  res.json({ ok: true, users });
}));

async function sendApprovalEmail(user) {
  try {
    await sendEmail({
      to: user.email,
      subject: "Your ZMH account has been approved",
      text: `Hi ${user.name}, your ZMH USA Corp account has been approved. You can now log in at https://zmhusacorp.com/login.`,
      html: `<p>Hi ${user.name},</p><p>Your ZMH USA Corp account has been approved.</p><p>You can now log in at <a href="https://zmhusacorp.com/login">https://zmhusacorp.com/login</a>.</p>`,
    });
    return true;
  } catch (error) {
    console.error("[approval email failed]", error.message);
    return false;
  }
}

router.post("/users/:id/approve", asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) {
    const error = new Error("User not found");
    error.statusCode = 404;
    throw error;
  }

  const shouldNotify = user.status !== "active";
  user.status = "active";
  user.isEmailVerified = true;
  await user.save();

  await Notification.create({
    user: user._id,
    title: "Account approved",
    body: "Your account has been approved. You can now log in to your client dashboard.",
    type: "account",
  });

  const emailSent = shouldNotify ? await sendApprovalEmail(user) : false;

  const saved = await User.findById(user._id).select("-passwordHash");
  res.json({
    ok: true,
    user: saved,
    emailSent,
    message: emailSent ? "User approved and email sent." : "User approved. Approval email was not sent.",
  });
}));

router.patch("/users/:id", asyncHandler(async (req, res) => {
  const allowed = ["name", "company", "phone", "role", "status", "isEmailVerified"];
  const update = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) update[key] = req.body[key];
  }
  const existing = await User.findById(req.params.id);
  if (!existing) {
    const error = new Error("User not found");
    error.statusCode = 404;
    throw error;
  }

  const shouldNotifyApproval = existing.status !== "active" && update.status === "active";
  const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select("-passwordHash");

  if (shouldNotifyApproval) {
    await Notification.create({
      user: user._id,
      title: "Account approved",
      body: "Your account has been approved. You can now log in to your client dashboard.",
      type: "account",
    });
    await sendApprovalEmail(user);
  }

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
