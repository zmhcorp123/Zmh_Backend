const express = require("express");
const { Invoice, Notification, Booking, OrderProgress, Setting, SupportTicket } = require("../models");
const { sendEmail } = require("../config/email");
const { asyncHandler } = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");
const { publicUser } = require("../utils/publicUser");

const router = express.Router();

function escapePdf(value = "") {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Not selected";
}

function billMonth(invoice) {
  const value = invoice.dueDate || invoice.createdAt || new Date();
  return new Date(value).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

async function accountDetails() {
  const setting = await Setting.findOne({ key: "accountDetails" });
  return setting?.value || {};
}

function createBillPdfBuffer(invoice, user, bank = {}) {
  const rows = [
    ["Invoice", invoice.invoice],
    ["Billing Month", billMonth(invoice)],
    ["Company", invoice.company || user.company || "Not provided"],
    ["Amount Due", `${invoice.currency || "USD"} ${Number(invoice.amount || 0).toFixed(2)}`],
    ["Status", invoice.status],
    ["Due Date", formatDate(invoice.dueDate)],
  ];
  const lineItems = invoice.lineItems?.length ? invoice.lineItems : [{ label: invoice.message || "Monthly service bill", amount: invoice.amount }];
  const bankRows = [
    ["Beneficiary", bank.beneficiaryName || "ZMH USA Corp"],
    ["Bank", bank.bankName || "Available on request"],
    ["Account", bank.accountNumber || "Provided by admin"],
    ["Routing", bank.routingNumber || "Provided by admin"],
    ["SWIFT", bank.swiftCode || bank.iban || "Provided by admin"],
    ["Reference", `${bank.referencePrefix || "ZMH"}-${invoice.invoice}`],
  ];
  const text = (x, y, value, size = 10, font = "F1", color = "0.10 0.14 0.22") => `BT /${font} ${size} Tf ${color} rg ${x} ${y} Td (${escapePdf(value)}) Tj ET`;
  const rect = (x, y, w, h, color = "1 1 1") => `${color} rg ${x} ${y} ${w} ${h} re f`;
  const content = [
    rect(0, 0, 612, 792, "0.97 0.98 1"),
    rect(0, 642, 612, 150, "0.04 0.11 0.24"),
    text(48, 716, "ZMH USA Corp", 24, "F2", "1 1 1"),
    text(48, 690, "Monthly Client Bill", 14, "F1", "0.82 0.91 1"),
    text(430, 716, invoice.invoice, 13, "F2", "1 1 1"),
    text(430, 692, billMonth(invoice), 10, "F1", "0.82 0.91 1"),
    rect(48, 510, 516, 104),
    ...rows.map(([label, value], index) => {
      const x = index % 2 === 0 ? 72 : 316;
      const y = 580 - Math.floor(index / 2) * 34;
      return [text(x, y, label, 8, "F2", "0.40 0.45 0.54"), text(x, y - 15, value, 11, "F2")].join("\n");
    }),
    text(48, 462, "Line Items", 16, "F2"),
    ...lineItems.slice(0, 8).map((item, index) => {
      const y = 426 - index * 28;
      return [rect(48, y - 8, 516, 24, index % 2 ? "0.98 0.99 1" : "1 1 1"), text(66, y, item.label || "Monthly service", 10, "F1"), text(468, y, `${invoice.currency || "USD"} ${Number(item.amount || 0).toFixed(2)}`, 10, "F2")].join("\n");
    }),
    rect(348, 178, 216, 66, "0.04 0.11 0.24"),
    text(368, 218, "Total Due", 11, "F1", "0.82 0.91 1"),
    text(368, 192, `${invoice.currency || "USD"} ${Number(invoice.amount || 0).toFixed(2)}`, 22, "F2", "1 1 1"),
    text(48, 234, "Bank Transfer Details", 16, "F2"),
    ...bankRows.map(([label, value], index) => {
      const y = 206 - index * 24;
      return [text(48, y, label, 8, "F2", "0.40 0.45 0.54"), text(148, y, value, 9, "F1")].join("\n");
    }),
    text(48, 52, "Generated from your ZMH USA Corp client dashboard.", 9, "F1", "0.40 0.45 0.54"),
  ].join("\n");
  const stream = Buffer.from(content, "latin1");
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >> endobj",
    `6 0 obj << /Length ${stream.length} >> stream\n${content}\nendstream endobj`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${object}\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

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
  res.json({ ok: true, invoices: invoices.map((invoice) => ({ ...invoice.toObject(), billingMonth: billMonth(invoice), pdfAvailable: true })) });
}));

router.get("/invoices/:id/pdf", requireAuth, asyncHandler(async (req, res) => {
  const filter = req.user.role === "admin" ? { _id: req.params.id } : { _id: req.params.id, user: req.user._id };
  const invoice = await Invoice.findOne(filter);
  if (!invoice) {
    const error = new Error("Invoice not found");
    error.statusCode = 404;
    throw error;
  }
  const pdf = createBillPdfBuffer(invoice, req.user, await accountDetails());
  res.json({
    ok: true,
    filename: `${invoice.invoice}.pdf`,
    invoice: invoice.invoice,
    billingMonth: billMonth(invoice),
    pdfBase64: pdf.toString("base64"),
  });
}));

router.get("/dashboard/services", requireAuth, asyncHandler(async (req, res) => {
  const filter = req.user.role === "admin" ? {} : { user: req.user._id };
  const orders = await Booking.find(filter).sort({ updatedAt: -1 }).limit(20);
  const orderIds = orders.map((order) => order._id);
  const progress = await OrderProgress.find({ order: { $in: orderIds } }).populate("admin", "name email").sort({ happenedAt: -1 });
  const progressByOrder = progress.reduce((map, item) => {
    const key = String(item.order);
    if (!map[key]) map[key] = [];
    map[key].push(item);
    return map;
  }, {});
  const services = orders.map((order) => {
    const timeline = progressByOrder[String(order._id)] || [];
    const activeServices = order.activeServices?.length ? order.activeServices : order.services || [];
    return {
      ...order.toObject(),
      activeServices,
      progressTimeline: timeline,
      latestProgress: timeline[0] || null,
      progressPercent: Number(order.progressPercent || timeline[0]?.progressPercent || 0),
    };
  });
  res.json({ ok: true, services });
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
