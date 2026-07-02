const express = require("express");
const { Invoice, Notification, Booking, OrderProgress, PaymentSubmission, Setting, SupportTicket, User } = require("../models");
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

function cleanString(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function normalizePaymentStatus(value = "") {
  return String(value || "").replace(/-/g, " ").toLowerCase();
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

router.patch("/dashboard/profile", requireAuth, asyncHandler(async (req, res) => {
  const allowed = ["name", "username", "company", "phone", "profilePicture"];
  const update = {};

  for (const field of allowed) {
    if (!Object.prototype.hasOwnProperty.call(req.body, field)) continue;
    update[field] = String(req.body[field] ?? "").trim();
  }

  if (Object.prototype.hasOwnProperty.call(update, "name") && !update.name) {
    const error = new Error("Full name is required");
    error.statusCode = 400;
    throw error;
  }

  if (update.phone && !/^[+()\-\s\d.]{7,24}$/.test(update.phone)) {
    const error = new Error("Enter a valid phone number");
    error.statusCode = 400;
    throw error;
  }

  if (update.profilePicture && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(update.profilePicture) && !/^https?:\/\//i.test(update.profilePicture)) {
    const error = new Error("Profile picture must be an image upload or valid URL");
    error.statusCode = 400;
    throw error;
  }

  const user = await User.findByIdAndUpdate(req.user._id, update, { new: true, runValidators: true }).select("-passwordHash");
  res.json({ ok: true, user: publicUser(user), message: "Profile updated." });
}));

router.get("/invoices", requireAuth, asyncHandler(async (req, res) => {
  const filter = req.user.role === "admin" ? {} : { user: req.user._id };
  const invoices = await Invoice.find(filter).sort({ createdAt: -1 });
  const submissions = await PaymentSubmission.find({ invoice: { $in: invoices.map((invoice) => invoice._id) } }).sort({ createdAt: -1 });
  const submissionByInvoice = submissions.reduce((map, item) => {
    const key = String(item.invoice);
    if (!map[key]) map[key] = item;
    return map;
  }, {});
  res.json({ ok: true, invoices: invoices.map((invoice) => ({ ...invoice.toObject(), billingMonth: billMonth(invoice), pdfAvailable: true, paymentSubmission: submissionByInvoice[String(invoice._id)] || null })) });
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
  const [progress, invoices, submissions] = await Promise.all([
    OrderProgress.find({ order: { $in: orderIds } }).populate("admin", "name email").sort({ happenedAt: -1 }),
    Invoice.find(req.user.role === "admin" ? {} : { user: req.user._id }).sort({ createdAt: -1 }),
    PaymentSubmission.find(req.user.role === "admin" ? {} : { user: req.user._id }).sort({ createdAt: -1 }),
  ]);
  const progressByOrder = progress.reduce((map, item) => {
    const key = String(item.order);
    if (!map[key]) map[key] = [];
    map[key].push(item);
    return map;
  }, {});
  const submissionsByInvoice = submissions.reduce((map, item) => {
    const key = String(item.invoice);
    if (!map[key]) map[key] = [];
    map[key].push(item);
    return map;
  }, {});
  const services = orders.map((order) => {
    const timeline = progressByOrder[String(order._id)] || [];
    const activeServices = order.activeServices?.length ? order.activeServices : order.services || [];
    const orderInvoices = invoices.filter((invoice) => String(invoice.user || "") === String(order.user || "") || invoice.company === order.companyName);
    const latestInvoice = orderInvoices[0] || null;
    const paymentHistory = orderInvoices.flatMap((invoice) => (submissionsByInvoice[String(invoice._id)] || []).map((submission) => ({ ...submission.toObject(), invoice })));
    return {
      ...order.toObject(),
      activeServices,
      progressTimeline: timeline,
      latestProgress: timeline[0] || null,
      invoices: orderInvoices,
      latestInvoice,
      paymentHistory,
      progressPercent: Number(order.progressPercent || timeline[0]?.progressPercent || 0),
    };
  });
  res.json({ ok: true, services });
}));

router.post("/payments/submit", requireAuth, asyncHandler(async (req, res) => {
  const invoiceId = cleanString(req.body?.invoiceId);
  const orderId = cleanString(req.body?.orderId);
  const paymentDate = req.body?.paymentDate ? new Date(req.body.paymentDate) : null;
  const paymentMethod = cleanString(req.body?.paymentMethod);
  const transactionId = cleanString(req.body?.transactionId);
  const note = cleanString(req.body?.note);
  const screenshot = req.body?.screenshot && typeof req.body.screenshot === "object" ? {
    name: cleanString(req.body.screenshot.name),
    dataUrl: cleanString(req.body.screenshot.dataUrl),
  } : undefined;

  if (!invoiceId || !paymentDate || Number.isNaN(paymentDate.getTime()) || !paymentMethod || !transactionId) {
    const error = new Error("Payment date, method, transaction ID, and invoice are required.");
    error.statusCode = 400;
    throw error;
  }

  const invoice = await Invoice.findOne({ _id: invoiceId, user: req.user._id });
  if (!invoice) {
    const error = new Error("Invoice not found.");
    error.statusCode = 404;
    throw error;
  }
  if (invoice.status === "paid") {
    const error = new Error("This invoice is already marked paid.");
    error.statusCode = 409;
    throw error;
  }
  const existing = await PaymentSubmission.findOne({ invoice: invoice._id, user: req.user._id, status: "submitted" });
  if (existing) {
    const error = new Error("Payment proof was already submitted and is waiting for admin verification.");
    error.statusCode = 409;
    throw error;
  }

  const order = orderId ? await Booking.findOne({ _id: orderId, user: req.user._id }) : await Booking.findOne({ user: req.user._id, companyName: invoice.company }).sort({ updatedAt: -1 });
  const payment = await PaymentSubmission.create({
    user: req.user._id,
    order: order?._id || null,
    invoice: invoice._id,
    amount: invoice.amount,
    currency: invoice.currency,
    paymentDate,
    paymentMethod,
    transactionId,
    note,
    screenshot,
  });
  if (order) {
    order.paymentStatus = "payment submitted";
    await order.save();
  }
  await Notification.create({
    user: req.user._id,
    title: "Payment submitted",
    body: `Your payment proof for ${invoice.invoice} was submitted and is waiting for admin verification.`,
    type: "billing",
  });
  try {
    await sendEmail({
      to: process.env.ACCOUNTS_EMAIL || "accounts@zmhusacorp.com",
      from: "ZMH USA Corp Accounts <accounts@zmhusacorp.com>",
      subject: `Payment submitted: ${invoice.invoice}`,
      text: `${req.user.name} submitted payment proof for ${invoice.invoice}. Transaction: ${transactionId}.`,
      html: `<p><strong>${req.user.name}</strong> submitted payment proof for <strong>${invoice.invoice}</strong>.</p><p>Method: ${paymentMethod}<br />Transaction: ${transactionId}<br />Amount: ${invoice.currency} ${invoice.amount}</p>`,
    });
  } catch (error) {
    console.error("[payment submitted email failed]", error.message);
  }
  res.status(201).json({ ok: true, payment, paymentStatus: normalizePaymentStatus("payment submitted") });
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
