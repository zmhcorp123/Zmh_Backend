const express = require("express");
const { Invoice, Notification, Booking, SupportTicket } = require("../models");
const { sendEmail } = require("../config/email");
const { asyncHandler } = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");
const { publicUser } = require("../utils/publicUser");

const router = express.Router();

router.get("/dashboard/profile", requireAuth, asyncHandler(async (req, res) => {
  const bookings = await Booking.countDocuments({ user: req.user._id });
  const invoices = await Invoice.countDocuments({ user: req.user._id });
  const notifications = await Notification.countDocuments({ user: req.user._id, readAt: null });
  const tickets = await SupportTicket.countDocuments({ user: req.user._id });
  res.json({ ok: true, user: publicUser(req.user), stats: { bookings, invoices, notifications, tickets } });
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

router.get("/support-tickets", requireAuth, asyncHandler(async (req, res) => {
  const filter = req.user.role === "admin" ? {} : { user: req.user._id };
  const tickets = await SupportTicket.find(filter).populate("user", "name email company phone").sort({ createdAt: -1 });
  res.json({ ok: true, tickets });
}));

router.post("/support-tickets", requireAuth, asyncHandler(async (req, res) => {
  const subject = String(req.body?.subject || "").trim();
  const message = String(req.body?.message || "").trim();
  if (!subject || !message) {
    const error = new Error("Subject and message are required");
    error.statusCode = 400;
    throw error;
  }

  const ticket = await SupportTicket.create({ user: req.user._id, subject, message });
  try {
    await sendEmail({
      to: process.env.SUPPORT_EMAIL || "support@zmhusacorp.com",
      subject: `New support ticket: ${subject}`,
      text: `A new support ticket was created.\n\nUser: ${req.user.name}\nEmail: ${req.user.email}\nCompany: ${req.user.company || "Not provided"}\n\n${message}`,
      html: `
        <p>A new support ticket was created.</p>
        <ul>
          <li><strong>User:</strong> ${req.user.name}</li>
          <li><strong>Email:</strong> ${req.user.email}</li>
          <li><strong>Company:</strong> ${req.user.company || "Not provided"}</li>
        </ul>
        <p>${message}</p>
      `,
    });
  } catch (error) {
    console.error("[support ticket email failed]", error.message);
  }

  res.status(201).json({ ok: true, ticket });
}));

module.exports = router;
