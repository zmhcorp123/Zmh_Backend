const express = require("express");
const { Booking } = require("../models");
const { asyncHandler } = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function normalizeBooking(body) {
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
  };
}

router.post("/", asyncHandler(async (req, res) => {
  const payload = normalizeBooking(req.body);
  if (!payload.companyName) {
    const error = new Error("Company name is required");
    error.statusCode = 400;
    throw error;
  }
  const booking = await Booking.create(payload);
  res.status(201).json({ ok: true, booking });
}));

router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const filter = req.user.role === "admin" ? {} : { user: req.user._id };
  const bookings = await Booking.find(filter).sort({ createdAt: -1 });
  res.json({ ok: true, bookings });
}));

module.exports = router;
