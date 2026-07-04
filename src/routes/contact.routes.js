const express = require("express");
const { Contact } = require("../models");
const { sendEmail } = require("../config/email");
const { EMAIL_ADDRESSES, EMAIL_SENDERS } = require("../config/emailConfig");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

function inquiryRecipients() {
  return [...new Set([
    process.env.CONTACT_TO_EMAIL,
    process.env.SUPPORT_EMAIL,
    EMAIL_ADDRESSES.support,
  ].filter(Boolean))];
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

router.post("/", asyncHandler(async (req, res) => {
  const { name, company = "", email, phone = "", message } = req.body;
  if (!name || !email || !message) {
    const error = new Error("Name, email, and message are required");
    error.statusCode = 400;
    throw error;
  }

  const contact = await Contact.create({ name, company, email, phone, message });
  await sendEmail({
    to: inquiryRecipients(),
    from: EMAIL_SENDERS.sales,
    subject: `New ZMH inquiry from ${name}`,
    text: `${name} (${email}) from ${company || "No company"} wrote: ${message}`,
    html: `<p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) from ${escapeHtml(company || "No company")} wrote:</p><p>${escapeHtml(message)}</p><p>Phone: ${escapeHtml(phone || "Not provided")}</p>`,
  });

  res.status(201).json({ ok: true, contact, message: "Inquiry received." });
}));

module.exports = router;
