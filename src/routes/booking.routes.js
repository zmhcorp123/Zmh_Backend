const express = require("express");
const { Booking, User } = require("../models");
const { asyncHandler } = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");
const jwt = require("jsonwebtoken");

const router = express.Router();

function normalizeBooking(body) {
  const requestedDate = body.requestedDate || body.date || body.bookingDate || "";
  return {
    companyName: body.companyName || body["Company Name"],
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
  if (req.user?._id) payload.user = req.user._id;
  const booking = await Booking.create(payload);
  res.status(201).json({ ok: true, booking });
}));

router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const filter = req.user.role === "admin" ? {} : { user: req.user._id };
  const bookings = await Booking.find(filter).sort({ createdAt: -1 });
  res.json({ ok: true, bookings });
}));

module.exports = router;
