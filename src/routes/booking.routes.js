const express = require("express");
const { Booking, User } = require("../models");
const { sendEmail } = require("../config/email");
const { asyncHandler } = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");
const jwt = require("jsonwebtoken");

const router = express.Router();

function normalizeBooking(body) {
  const requestedDate = body.requestedDate || body.date || body.bookingDate || "";
  return {
    companyName: body.companyName || body["Company Name"],
    email: body.email || body.Email || body["Email"],
    businessType: body.businessType || body["Business Type"],
    employees: body.employees || body.Employees,
    website: body.website || body.Website,
    phone: body.phone || body.Phone,
    address: body.address || body.Address,
    services: Array.isArray(body.services) ? body.services : [],
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
    `Hours: ${booking.hours || "Not provided"}`,
    `CRM: ${booking.crm || "Not provided"}`,
  ].join("\n");
}

function inquiryRecipients() {
  return process.env.CONTACT_TO_EMAIL || process.env.SUPPORT_EMAIL || "support@zmhusacorp.com";
}

async function notifySalesOfBooking(booking, user) {
  try {
    await sendEmail({
      to: [process.env.SALES_EMAIL || "sales@zmhusacorp.com", inquiryRecipients()],
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
      const payload = jwt.verify(token, process.env.JWT_SECRET || "dev-secret-change-me");
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
  if (req.user?.email && !payload.email) payload.email = req.user.email;
  if (req.user?._id) payload.user = req.user._id;
  const booking = await Booking.create(payload);
  const salesEmailSent = await notifySalesOfBooking(booking, req.user);
  res.status(201).json({ ok: true, booking, salesEmailSent });
}));

router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const filter = req.user.role === "admin" ? {} : { user: req.user._id };
  const bookings = await Booking.find(filter).sort({ createdAt: -1 });
  res.json({ ok: true, bookings });
}));

module.exports = router;
