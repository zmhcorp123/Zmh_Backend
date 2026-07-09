const express = require("express");
const { Booking, User } = require("../models");
const { sendEmail } = require("../config/email");
const { EMAIL_ADDRESSES, EMAIL_SENDERS } = require("../config/emailConfig");
const { asyncHandler } = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");
const { JWT_SECRET } = require("../config/env");
const { validateEmail } = require("../utils/validateEmail");
const jwt = require("jsonwebtoken");

const router = express.Router();
const OPERATING_DAY_OPTIONS = ["Monday-Friday", "Monday-Saturday", "Weekends only", "Every day"];
const HOUR_OPTIONS = ["8 AM-5 PM", "9 AM-6 PM", "10 AM-7 PM", "24/7 coverage"];
const AFTER_HOURS_OPTIONS = ["No after-hours", "Evening calls", "Weekend coverage", "Emergency calls", "Overflow support"];

function validateOption(value, options, message) {
  if (!options.includes(value)) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }
}

function normalizeBooking(body) {
  const requestedDate = body.requestedDate || body.date || body.bookingDate || "";
  return {
    companyName: body.companyName || body["Company Name"],
    email: body.email || body.Email || body["Email"],
    businessType: body.businessType || body["Business Type"],
    website: body.website || body.Website,
    phone: body.phone || body.Phone,
    address: body.address || body.Address,
    services: Array.isArray(body.services) ? body.services : [],
    operatingDays: body.operatingDays,
    hours: body.hours,
    afterHours: body.afterHours,
    crm: body.crm,
    integrationNotes: body.integrationNotes,
    requestedDate: requestedDate ? new Date(requestedDate) : null,
  };
}

function bookingSummary(booking) {
  return [
    `Company: ${booking.companyName}`,
    `Email: ${booking.email || "Not provided"}`,
    `Phone: ${booking.phone || "Not provided"}`,
    `Services: ${booking.services?.length ? booking.services.join(", ") : "Not selected"}`,
    `Requested date: ${booking.requestedDate ? booking.requestedDate.toDateString() : "Not selected"}`,
    `Operating days: ${booking.operatingDays || "Not provided"}`,
    `Hours: ${booking.hours || "Not provided"}`,
    `After-hours needs: ${booking.afterHours || "Not provided"}`,
    `CRM: ${booking.crm || "Not provided"}`,
  ].join("\n");
}

function inquiryRecipients() {
  return process.env.CONTACT_TO_EMAIL || process.env.SUPPORT_EMAIL || EMAIL_ADDRESSES.support;
}

async function notifySalesOfBooking(booking, user) {
  try {
    await sendEmail({
      to: [process.env.SALES_EMAIL || EMAIL_ADDRESSES.sales, inquiryRecipients()],
      from: EMAIL_SENDERS.sales,
      subject: `New booking request from ${booking.companyName}`,
      text: `A new booking request was submitted.\n\n${bookingSummary(booking)}\n\nUser account: ${user?.email || "Public visitor"}`,
      html: `
        <p>A new booking request was submitted.</p>
        <ul>
          <li><strong>Company:</strong> ${booking.companyName}</li>
          <li><strong>Email:</strong> ${booking.email || "Not provided"}</li>
          <li><strong>Phone:</strong> ${booking.phone || "Not provided"}</li>
          <li><strong>Services:</strong> ${booking.services?.length ? booking.services.join(", ") : "Not selected"}</li>
          <li><strong>Requested date:</strong> ${booking.requestedDate ? booking.requestedDate.toDateString() : "Not selected"}</li>
          <li><strong>Operating days:</strong> ${booking.operatingDays || "Not provided"}</li>
          <li><strong>Hours:</strong> ${booking.hours || "Not provided"}</li>
          <li><strong>After-hours needs:</strong> ${booking.afterHours || "Not provided"}</li>
          <li><strong>CRM:</strong> ${booking.crm || "Not provided"}</li>
          <li><strong>User account:</strong> ${user?.email || "Public visitor"}</li>
        </ul>
      `,
    });
    return true;
  } catch (error) {
    console.error("[sales booking email failed]", error.message);
    return false;
  }
}

async function attachUserIfPresent(req, _res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (token) {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = await User.findById(payload.id).select("-passwordHash");
    }
    next();
  } catch (_error) {
    next();
  }
}

router.post("/", attachUserIfPresent, asyncHandler(async (req, res) => {
  const payload = normalizeBooking(req.body);
  if (!payload.companyName) {
    const error = new Error("Company name is required");
    error.statusCode = 400;
    throw error;
  }
  if (!payload.requestedDate || Number.isNaN(payload.requestedDate.getTime())) {
    const error = new Error("Booking date is required");
    error.statusCode = 400;
    throw error;
  }
  validateOption(payload.operatingDays, OPERATING_DAY_OPTIONS, "Select valid operating days");
  validateOption(payload.hours, HOUR_OPTIONS, "Select valid opening hours");
  validateOption(payload.afterHours, AFTER_HOURS_OPTIONS, "Select valid after-hours needs");
  if (req.user?.email && !payload.email) payload.email = req.user.email;
  if (payload.email) payload.email = validateEmail(payload.email);
  if (req.user?._id) payload.user = req.user._id;
  const booking = await Booking.create(payload);
  notifySalesOfBooking(booking, req.user).catch((error) => {
    console.error("[sales booking email failed]", error.message);
  });
  res.status(201).json({ ok: true, booking, salesEmailQueued: true });
}));

router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const filter = req.user.role === "admin" ? {} : { user: req.user._id };
  const bookings = await Booking.find(filter).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ ok: true, bookings });
}));

module.exports = router;
