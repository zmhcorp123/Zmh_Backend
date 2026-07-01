const express = require("express");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

const services = [
  "Call Answering",
  "Dispatch",
  "Scheduling",
  "Customer Support",
  "CRM Management",
  "Billing Support",
  "Lead Qualification",
  "After Hours Coverage",
];

const industries = ["HVAC", "Plumbing", "Roofing", "Electrical", "Cleaning", "Property Management"];

router.post("/query", asyncHandler(async (req, res) => {
  const question = String(req.body.question || req.body.message || "").toLowerCase();
  let answer = "Would you like to book a free operations audit or contact a ZMH specialist?";

  if (question.includes("price") || question.includes("package") || question.includes("cost")) {
    answer = "ZMH pricing is custom across Starter, Growth, Professional, and Enterprise packages. A free operations audit helps prepare the right quote.";
  } else if (question.includes("service") || question.includes("dispatch") || question.includes("call")) {
    answer = `ZMH supports ${services.join(", ")} and other remote operations workflows.`;
  } else if (question.includes("industry") || question.includes("hvac") || question.includes("plumbing")) {
    answer = `ZMH supports ${industries.join(", ")} and other home service companies.`;
  } else if (question.includes("after hours")) {
    answer = "After-hours coverage can be configured for evenings, weekends, emergencies, and overflow call windows.";
  } else if (question.includes("crm")) {
    answer = "The backend is prepared for CRM notes, workflow data, and future integrations with common home service platforms.";
  }

  res.json({ ok: true, answer });
}));

module.exports = router;
