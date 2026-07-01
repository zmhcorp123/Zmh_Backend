const express = require("express");
const { Booking, Invoice, Notification, Setting, SupportTicket, User } = require("../models");
const { sendEmail } = require("../config/email");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

router.use(requireAuth, requireAdmin);

function bookingCustomerEmail(booking) {
  return booking.email || booking.user?.email || "";
}

async function sendBookingDecisionEmail(booking) {
  const to = bookingCustomerEmail(booking);
  if (!to) return false;

  const isCancelled = booking.status === "cancelled";
  const isDiscussion = booking.status === "needs discussion";
  const subject = isCancelled
    ? "Your ZMH booking request was cancelled"
    : isDiscussion
      ? "Your ZMH booking request needs discussion"
      : "Your ZMH booking request was accepted";
  const response = booking.adminResponse || (isCancelled
    ? "Your booking request has been cancelled by the admin team."
    : isDiscussion
      ? "Your booking request needs a discussion with our team before it can move forward."
      : "Your booking request has been accepted by the admin team.");

  try {
    await sendEmail({
      to,
      subject,
      text: `Hi${booking.user?.name ? " " + booking.user.name : ""},\n\n${response}\n\nCompany: ${booking.companyName}\nStatus: ${booking.status}\nRequested date: ${booking.requestedDate ? booking.requestedDate.toDateString() : "Not selected"}\n\nZMH USA Corp`,
      html: `
        <p>Hi${booking.user?.name ? " " + booking.user.name : ""},</p>
        <p>${response}</p>
        <ul>
          <li><strong>Company:</strong> ${booking.companyName}</li>
          <li><strong>Status:</strong> ${booking.status}</li>
          <li><strong>Requested date:</strong> ${booking.requestedDate ? booking.requestedDate.toDateString() : "Not selected"}</li>
        </ul>
        <p>ZMH USA Corp</p>
      `,
    });
    return true;
  } catch (error) {
    console.error("[booking decision email failed]", error.message);
    return false;
  }
}

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
  const allowed = ["status", "notes", "services", "hours", "afterHours", "crm", "integrationNotes", "requestedDate", "adminResponse", "activeServices", "serviceUpdates"];
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
  if (update.status === "accepted") update.status = "ongoing";
  if (update.status === "needs review") update.status = "needs discussion";
  if (Object.prototype.hasOwnProperty.call(update, "activeServices") && !Array.isArray(update.activeServices)) {
    update.activeServices = String(update.activeServices).split("\n").map((item) => item.trim()).filter(Boolean);
  }
  const booking = await Booking.findByIdAndUpdate(req.params.id, update, { new: true }).populate("user", "name email company");
  let emailSent = false;
  if (booking?.user?._id && (update.adminResponse || update.status)) {
    await Notification.create({
      user: booking.user._id,
      title: "Booking update",
      body: update.adminResponse || `Your booking status is now ${booking.status}.`,
      type: "booking",
    });
  }
  if (booking && ["ongoing", "cancelled", "needs discussion"].includes(booking.status) && (update.adminResponse || update.status)) {
    emailSent = await sendBookingDecisionEmail(booking);
  }
  res.json({ ok: true, booking, emailSent });
}));

router.get("/settings", asyncHandler(async (_req, res) => {
  const settings = await Setting.find().sort({ key: 1 });
  res.json({ ok: true, settings });
}));

router.get("/bills", asyncHandler(async (_req, res) => {
  const bills = await Invoice.find().populate("user", "name email company").sort({ createdAt: -1 });
  res.json({ ok: true, bills });
}));

async function emailBill(user, invoice) {
  if (!user?.email) return false;
  try {
    await sendEmail({
      to: user.email,
      subject: `ZMH invoice ${invoice.invoice}`,
      text: `Hi ${user.name},\n\nA new bill has been sent to your ZMH account.\n\nInvoice: ${invoice.invoice}\nAmount: ${invoice.currency} ${invoice.amount}\nDue date: ${invoice.dueDate ? invoice.dueDate.toDateString() : "Not selected"}\n${invoice.message || ""}`,
      html: `
        <p>Hi ${user.name},</p>
        <p>A new bill has been sent to your ZMH account.</p>
        <ul>
          <li><strong>Invoice:</strong> ${invoice.invoice}</li>
          <li><strong>Amount:</strong> ${invoice.currency} ${invoice.amount}</li>
          <li><strong>Due date:</strong> ${invoice.dueDate ? invoice.dueDate.toDateString() : "Not selected"}</li>
        </ul>
        ${invoice.message ? `<p>${invoice.message}</p>` : ""}
      `,
    });
    return true;
  } catch (error) {
    console.error("[bill email failed]", error.message);
    return false;
  }
}

router.post("/bills/send", asyncHandler(async (req, res) => {
  const { scope = "individual", userId, userIds = [], amount = 0, currency = "USD", dueDate, lineItems = [], message = "" } = req.body || {};
  let users = [];

  if (scope === "all") {
    users = await User.find({ role: { $ne: "admin" }, status: "active" }).select("-passwordHash");
  } else if (scope === "custom") {
    users = await User.find({ _id: { $in: userIds } }).select("-passwordHash");
  } else if (userId) {
    const user = await User.findById(userId).select("-passwordHash");
    if (user) users = [user];
  }

  if (!users.length) {
    const error = new Error("Select at least one user to send a bill.");
    error.statusCode = 400;
    throw error;
  }

  const invoices = [];
  let emailsSent = 0;
  for (const user of users) {
    const invoice = await Invoice.create({
      user: user._id,
      invoice: `ZMH-${Date.now()}-${String(user._id).slice(-4)}`,
      company: user.company || user.name,
      amount: Number(amount) || 0,
      currency,
      status: "sent",
      dueDate: dueDate ? new Date(dueDate) : null,
      lineItems,
      message,
    });
    invoices.push(invoice);
    if (await emailBill(user, invoice)) emailsSent += 1;
  }

  res.status(201).json({ ok: true, bills: invoices, emailsSent });
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

router.get("/support-tickets", asyncHandler(async (_req, res) => {
  const tickets = await SupportTicket.find().populate("user", "name email company phone").sort({ createdAt: -1 });
  res.json({ ok: true, tickets });
}));

router.patch("/support-tickets/:id", asyncHandler(async (req, res) => {
  const update = {};
  if (Object.prototype.hasOwnProperty.call(req.body, "status")) update.status = req.body.status;
  if (Object.prototype.hasOwnProperty.call(req.body, "adminResponse")) update.adminResponse = req.body.adminResponse;
  if (update.status === "resolved") {
    update.resolvedAt = new Date();
    update.resolvedBy = req.user._id;
  }

  const ticket = await SupportTicket.findByIdAndUpdate(req.params.id, update, { new: true }).populate("user", "name email company phone");
  if (!ticket) {
    const error = new Error("Support ticket not found");
    error.statusCode = 404;
    throw error;
  }

  await Notification.create({
    user: ticket.user._id,
    title: update.status === "resolved" ? "Support ticket resolved" : "Support ticket updated",
    body: ticket.adminResponse || `Your ticket status is now ${ticket.status}.`,
    type: "support",
  });

  res.json({ ok: true, ticket });
}));

module.exports = router;
