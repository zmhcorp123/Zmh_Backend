const express = require("express");
const { Booking, EmailHistory, Invoice, Notification, OrderProgress, PackagePricing, Setting, SupportTicket, User } = require("../models");
const { sendEmail } = require("../config/email");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");

const router = express.Router();

router.use(requireAuth, requireAdmin);

function bookingCustomerEmail(booking) {
  return booking.email || booking.user?.email || "";
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanString(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function parseDate(value) {
  return value ? new Date(value) : null;
}

function normalizeFeatures(features = []) {
  if (typeof features === "string") {
    return features
      .split(/\r?\n|,/)
      .map((feature, index) => ({ text: feature.trim(), order: index }))
      .filter((feature) => feature.text);
  }
  return features
    .map((feature, index) => {
      if (typeof feature === "string") return { text: feature.trim(), order: index };
      return { text: cleanString(feature.text || feature.name), order: Number(feature.order ?? index) };
    })
    .filter((feature) => feature.text);
}

function normalizePackagePayload(item = {}, index = 0, adminId = null) {
  const name = cleanString(item.name || item.slug || `Package ${index + 1}`);
  const slug = cleanString(item.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""));
  return {
    slug,
    name,
    description: cleanString(item.description),
    bestFor: cleanString(item.bestFor || item.description),
    price: cleanString(item.price, "Custom"),
    displayOrder: Number(item.displayOrder ?? index),
    highlightBadge: cleanString(item.highlightBadge),
    buttonText: cleanString(item.buttonText, "Package details"),
    buttonLink: cleanString(item.buttonLink || `/pricing/${slug}`),
    status: item.status === "inactive" ? "inactive" : "active",
    recommended: Boolean(item.recommended),
    features: normalizeFeatures(item.features),
    updatedBy: adminId,
  };
}

function legacyPackage(item = {}, index = 0) {
  const normalized = normalizePackagePayload(item, index);
  return {
    ...normalized,
    _id: item._id,
    features: normalized.features.map((feature) => feature.text),
  };
}

function defaultAccountDetails() {
  return {
    beneficiaryName: "ZMH USA Corp",
    bankName: "Contact sales for bank details",
    accountNumber: "Provided on request",
    routingNumber: "",
    swiftCode: "",
    routingSwift: "Provided on request",
    branchName: "",
    bankAddress: "",
    referencePrefix: "ZMH",
    paymentInstructions: "Include the reference above with your transfer.",
  };
}

function normalizeAccountDetails(value = {}) {
  const defaults = defaultAccountDetails();
  return {
    beneficiaryName: cleanString(value.beneficiaryName, defaults.beneficiaryName),
    bankName: cleanString(value.bankName, defaults.bankName),
    accountNumber: cleanString(value.accountNumber, defaults.accountNumber),
    routingNumber: cleanString(value.routingNumber, defaults.routingNumber),
    swiftCode: cleanString(value.swiftCode, defaults.swiftCode),
    routingSwift: cleanString(value.routingSwift || [value.routingNumber, value.swiftCode].filter(Boolean).join(" / "), defaults.routingSwift),
    branchName: cleanString(value.branchName, defaults.branchName),
    bankAddress: cleanString(value.bankAddress, defaults.bankAddress),
    referencePrefix: cleanString(value.referencePrefix, defaults.referencePrefix),
    paymentInstructions: cleanString(value.paymentInstructions, defaults.paymentInstructions),
  };
}

function publicPackage(item) {
  return {
    _id: item._id,
    slug: item.slug,
    name: item.name,
    description: item.description,
    bestFor: item.bestFor || item.description,
    price: item.price,
    displayOrder: item.displayOrder,
    highlightBadge: item.highlightBadge,
    buttonText: item.buttonText,
    buttonLink: item.buttonLink || `/pricing/${item.slug}`,
    status: item.status,
    recommended: item.recommended,
    features: (item.features || []).sort((a, b) => a.order - b.order).map((feature) => feature.text || feature),
  };
}

async function buildOrderSummary(order) {
  const invoiceFilters = [{ company: order.companyName }];
  const orderUserId = order.user?._id || order.user;
  if (orderUserId) invoiceFilters.unshift({ user: orderUserId });
  const [progress, invoices, accountSetting] = await Promise.all([
    OrderProgress.find({ order: order._id }).populate("admin", "name email").sort({ happenedAt: -1 }),
    Invoice.find({ $or: invoiceFilters }).sort({ createdAt: -1 }).limit(20),
    Setting.findOne({ key: "accountDetails" }),
  ]);
  const serviceList = order.activeServices?.length ? order.activeServices : order.services || [];
  const completed = progress.filter((item) => item.status === "completed").map((item) => item.title);
  const remaining = serviceList.filter((service) => !completed.some((done) => done.toLowerCase().includes(String(service).toLowerCase())));

  return {
    company: {
      name: order.companyName,
      contactPerson: order.contactPerson || order.user?.name || "",
      email: bookingCustomerEmail(order),
      phone: order.phone,
      website: order.website,
      address: order.address,
    },
    package: {
      name: order.packageName || (serviceList[0] ? "Custom Operations Support" : "Custom Package"),
      price: order.packagePrice || "Custom",
      servicesIncluded: serviceList,
    },
    servicesCompleted: completed,
    servicesRemaining: remaining,
    timeline: progress,
    currentProgress: order.progressPercent || progress[0]?.progressPercent || 0,
    billing: {
      paymentStatus: order.paymentStatus,
      nextBillingDate: order.nextBillingDate,
      invoices,
    },
    accountDetails: normalizeAccountDetails(accountSetting?.value),
    notes: order.notes,
  };
}

function pdfEscape(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function createSummaryPdfBuffer(order, summary) {
  const lines = [
    "ZMH USA Corp",
    "Invoice & Service Summary",
    "",
    `Client: ${summary.company.name}`,
    `Contact: ${summary.company.contactPerson || "Not assigned"}`,
    `Email: ${summary.company.email || "Not provided"}`,
    `Phone: ${summary.company.phone || "Not provided"}`,
    "",
    `Package: ${summary.package.name}`,
    `Price: ${summary.package.price}`,
    `Order date: ${order.createdAt ? order.createdAt.toDateString() : "Not available"}`,
    `Service start: ${order.serviceStartDate ? order.serviceStartDate.toDateString() : "Not selected"}`,
    `Next billing: ${order.nextBillingDate ? order.nextBillingDate.toDateString() : "Not selected"}`,
    `Payment status: ${summary.billing.paymentStatus}`,
    `Progress: ${summary.currentProgress}%`,
    "",
    "Services Included",
    ...(summary.package.servicesIncluded.length ? summary.package.servicesIncluded.map((item) => `- ${item}`) : ["- Custom operations support"]),
    "",
    "Completed Services",
    ...(summary.servicesCompleted.length ? summary.servicesCompleted.map((item) => `- ${item}`) : ["- No completed progress updates yet"]),
    "",
    "Remaining Services",
    ...(summary.servicesRemaining.length ? summary.servicesRemaining.map((item) => `- ${item}`) : ["- Remaining services will be confirmed by the ZMH team"]),
    "",
    "Recent Timeline",
    ...(summary.timeline.length ? summary.timeline.slice(0, 8).map((item) => `- ${item.title} (${item.status}, ${item.progressPercent}%)`) : ["- Timeline updates will appear after admin progress is added"]),
    "",
    "Bank Transfer Details",
    `Beneficiary Name: ${summary.accountDetails.beneficiaryName}`,
    `Bank Name: ${summary.accountDetails.bankName}`,
    `Account Number: ${summary.accountDetails.accountNumber}`,
    `Routing Number: ${summary.accountDetails.routingNumber || "Provided on request"}`,
    `SWIFT Code: ${summary.accountDetails.swiftCode || "Provided on request"}`,
    `Branch Name: ${summary.accountDetails.branchName || "Not provided"}`,
    `Bank Address: ${summary.accountDetails.bankAddress || "Not provided"}`,
    `Reference: ${summary.accountDetails.referencePrefix}-${order._id}`,
    `Payment Instructions: ${summary.accountDetails.paymentInstructions}`,
    "",
    `Admin Notes: ${summary.notes || "No admin notes"}`,
    "",
    "Footer: zmhusacorp.com | sales@zmhusacorp.com | Page 1",
  ];

  const content = [
    "0.08 0.37 1 rg 0 760 612 32 re f",
    "1 1 1 rg BT /F1 18 Tf 48 770 Td (ZMH USA Corp) Tj ET",
    "0.06 0.09 0.16 rg BT /F1 11 Tf 48 730 Td",
    ...lines.map((line, index) => `${index ? "0 -16 Td" : ""} (${pdfEscape(line).slice(0, 92)}) Tj`),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf);
}

function buildSummaryEmail(order, summary) {
  const subject = `ZMH Invoice Summary for ${order.companyName}`;
  const html = `
    <div style="margin:0;padding:0;background:#f8fafc;font-family:Inter,Segoe UI,Arial,sans-serif;color:#172033">
      <div style="max-width:680px;margin:0 auto;padding:28px">
        <div style="background:#0b5fff;color:white;border-radius:18px 18px 0 0;padding:24px">
          <div style="font-size:24px;font-weight:900">ZMH USA Corp</div>
          <p style="margin:8px 0 0;color:#eaf1ff">Premium operations support summary</p>
        </div>
        <div style="background:white;border:1px solid #dce3ee;border-top:0;border-radius:0 0 18px 18px;padding:24px">
          <p>Hi ${escapeHtml(summary.company.contactPerson || order.companyName)},</p>
          <p>Your latest service and invoice summary is attached as a PDF. A quick overview is below.</p>
          <table style="width:100%;border-collapse:collapse;margin:18px 0">
            <tr><td style="padding:10px;border-bottom:1px solid #edf1f7"><strong>Company</strong></td><td style="padding:10px;border-bottom:1px solid #edf1f7">${escapeHtml(order.companyName)}</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #edf1f7"><strong>Package</strong></td><td style="padding:10px;border-bottom:1px solid #edf1f7">${escapeHtml(summary.package.name)}</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #edf1f7"><strong>Price</strong></td><td style="padding:10px;border-bottom:1px solid #edf1f7">${escapeHtml(summary.package.price)}</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #edf1f7"><strong>Progress</strong></td><td style="padding:10px;border-bottom:1px solid #edf1f7">${summary.currentProgress}%</td></tr>
            <tr><td style="padding:10px;border-bottom:1px solid #edf1f7"><strong>Payment</strong></td><td style="padding:10px;border-bottom:1px solid #edf1f7">${escapeHtml(summary.billing.paymentStatus)}</td></tr>
          </table>
          <p><strong>Completed:</strong> ${escapeHtml(summary.servicesCompleted.join(", ") || "Progress updates are being prepared.")}</p>
          <p><strong>Remaining:</strong> ${escapeHtml(summary.servicesRemaining.join(", ") || "No remaining services listed.")}</p>
          <p>Please review the attached PDF for service progress, invoice history, bank transfer details, and admin notes.</p>
          <p>Best regards,<br />ZMH USA Corp Sales Team</p>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #edf1f7;color:#667085;font-size:13px">sales@zmhusacorp.com | zmhusacorp.com</div>
        </div>
      </div>
    </div>`;
  const text = `Hi ${summary.company.contactPerson || order.companyName}, your ZMH invoice summary PDF is attached. Package: ${summary.package.name}. Progress: ${summary.currentProgress}%.`;
  return { subject, html, text };
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
  const allowed = ["status", "notes", "services", "hours", "afterHours", "crm", "integrationNotes", "requestedDate", "adminResponse", "activeServices", "serviceUpdates", "contactPerson", "packageName", "packagePrice", "assignedStaff", "serviceStartDate", "nextBillingDate", "progressPercent", "paymentStatus", "filesUploaded"];
  const update = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) update[key] = req.body[key];
  }
  if (Object.prototype.hasOwnProperty.call(update, "requestedDate")) {
    update.requestedDate = parseDate(update.requestedDate);
  }
  if (Object.prototype.hasOwnProperty.call(update, "serviceStartDate")) {
    update.serviceStartDate = parseDate(update.serviceStartDate);
  }
  if (Object.prototype.hasOwnProperty.call(update, "nextBillingDate")) {
    update.nextBillingDate = parseDate(update.nextBillingDate);
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

router.get("/orders", asyncHandler(async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const status = cleanString(req.query.status);
  const search = cleanString(req.query.search);
  const filter = {};
  if (status) filter.status = status;
  if (search) {
    filter.$or = [
      { companyName: new RegExp(search, "i") },
      { email: new RegExp(search, "i") },
      { phone: new RegExp(search, "i") },
      { packageName: new RegExp(search, "i") },
    ];
  }
  const [orders, total] = await Promise.all([
    Booking.find(filter).populate("user", "name email company phone").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    Booking.countDocuments(filter),
  ]);
  res.json({ ok: true, orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
}));

router.get("/orders/:id", asyncHandler(async (req, res) => {
  const order = await Booking.findById(req.params.id).populate("user", "name email company phone");
  if (!order) {
    const error = new Error("Order not found");
    error.statusCode = 404;
    throw error;
  }
  const summary = await buildOrderSummary(order);
  res.json({ ok: true, order, progress: summary.timeline, invoices: summary.billing.invoices, summary });
}));

router.patch("/orders/:id", asyncHandler(async (req, res) => {
  const allowed = ["status", "notes", "activeServices", "serviceUpdates", "contactPerson", "packageName", "packagePrice", "assignedStaff", "serviceStartDate", "nextBillingDate", "progressPercent", "paymentStatus", "filesUploaded"];
  const update = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) update[key] = req.body[key];
  }
  if (Object.prototype.hasOwnProperty.call(update, "serviceStartDate")) update.serviceStartDate = parseDate(update.serviceStartDate);
  if (Object.prototype.hasOwnProperty.call(update, "nextBillingDate")) update.nextBillingDate = parseDate(update.nextBillingDate);
  if (Object.prototype.hasOwnProperty.call(update, "activeServices") && !Array.isArray(update.activeServices)) {
    update.activeServices = String(update.activeServices).split("\n").map((item) => item.trim()).filter(Boolean);
  }
  if (Object.prototype.hasOwnProperty.call(update, "progressPercent")) {
    update.progressPercent = Math.max(0, Math.min(100, Number(update.progressPercent) || 0));
  }
  const order = await Booking.findByIdAndUpdate(req.params.id, update, { new: true }).populate("user", "name email company phone");
  if (!order) {
    const error = new Error("Order not found");
    error.statusCode = 404;
    throw error;
  }
  const summary = await buildOrderSummary(order);
  res.json({ ok: true, order, progress: summary.timeline, invoices: summary.billing.invoices, summary });
}));

router.post("/orders/:id/progress", asyncHandler(async (req, res) => {
  const order = await Booking.findById(req.params.id).populate("user", "name email company phone");
  if (!order) {
    const error = new Error("Order not found");
    error.statusCode = 404;
    throw error;
  }
  const progressPercent = Math.max(0, Math.min(100, Number(req.body.progressPercent) || 0));
  const title = cleanString(req.body.title);
  if (!title) {
    const error = new Error("Progress title is required");
    error.statusCode = 400;
    throw error;
  }
  const progress = await OrderProgress.create({
    order: order._id,
    title,
    description: cleanString(req.body.description),
    happenedAt: parseDate(req.body.happenedAt) || new Date(),
    adminName: cleanString(req.body.adminName || req.user.name),
    admin: req.user._id,
    attachments: Array.isArray(req.body.attachments) ? req.body.attachments : [],
    progressPercent,
    status: ["planned", "in progress", "completed", "blocked"].includes(req.body.status) ? req.body.status : "completed",
  });
  order.progressPercent = Math.max(order.progressPercent || 0, progressPercent);
  await order.save();
  if (order.user?._id) {
    await Notification.create({
      user: order.user._id,
      title: "Service progress updated",
      body: `${progress.title} - ${progress.progressPercent}% complete`,
      type: "order",
    });
  }
  const summary = await buildOrderSummary(order);
  res.status(201).json({ ok: true, order, progress, timeline: summary.timeline, summary });
}));

router.post("/orders/:id/pdf", asyncHandler(async (req, res) => {
  const order = await Booking.findById(req.params.id).populate("user", "name email company phone");
  if (!order) {
    const error = new Error("Order not found");
    error.statusCode = 404;
    throw error;
  }
  const summary = await buildOrderSummary(order);
  const pdf = createSummaryPdfBuffer(order, summary);
  res.json({
    ok: true,
    filename: `ZMH-${order._id}-summary.pdf`,
    contentType: "application/pdf",
    pdfBase64: pdf.toString("base64"),
    summary,
  });
}));

router.post("/orders/:id/send-invoice-summary", asyncHandler(async (req, res) => {
  const order = await Booking.findById(req.params.id).populate("user", "name email company phone");
  if (!order) {
    const error = new Error("Order not found");
    error.statusCode = 404;
    throw error;
  }
  const to = bookingCustomerEmail(order);
  if (!to) {
    const error = new Error("Order does not have a client email address");
    error.statusCode = 400;
    throw error;
  }
  const recent = await EmailHistory.findOne({
    order: order._id,
    to,
    status: { $in: ["sent", "skipped"] },
    createdAt: { $gte: new Date(Date.now() - 2 * 60 * 1000) },
  });
  if (recent && !req.body.force) {
    const error = new Error("Invoice summary was already sent recently. Wait a moment before sending again.");
    error.statusCode = 429;
    throw error;
  }
  const summary = await buildOrderSummary(order);
  const pdf = createSummaryPdfBuffer(order, summary);
  const email = buildSummaryEmail(order, summary);
  const history = new EmailHistory({
    order: order._id,
    to,
    from: "sales@zmhusacorp.com",
    subject: email.subject,
  });
  try {
    const result = await sendEmail({
      to,
      from: "ZMH USA Corp <sales@zmhusacorp.com>",
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: [{
        filename: `ZMH-${order._id}-summary.pdf`,
        content: pdf.toString("base64"),
        contentType: "application/pdf",
      }],
    });
    history.status = result?.skipped ? "skipped" : "sent";
    history.providerId = result?.id || "";
    await history.save();
    res.json({ ok: true, emailSent: history.status === "sent", skipped: history.status === "skipped", history, summary });
  } catch (error) {
    history.status = "failed";
    history.error = error.message;
    await history.save();
    throw error;
  }
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
    const settingValue = key === "accountDetails" ? normalizeAccountDetails(value) : value;
    const setting = await Setting.findOneAndUpdate(
      { key },
      { value: settingValue, updatedBy: req.user._id },
      { upsert: true, new: true }
    );
    saved.push(setting);
  }
  res.json({ ok: true, settings: saved });
}));

router.get("/pricing", asyncHandler(async (_req, res) => {
  const packages = await PackagePricing.find().sort({ displayOrder: 1, createdAt: 1 });
  if (packages.length) return res.json({ ok: true, packages: packages.map(publicPackage) });
  const setting = await Setting.findOne({ key: "packages" });
  const legacyPackages = Array.isArray(setting?.value) ? setting.value.map(legacyPackage) : [];
  res.json({ ok: true, packages: legacyPackages });
}));

router.put("/pricing", asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body.packages) ? req.body.packages : [];
  if (!rows.length) {
    const error = new Error("At least one package is required.");
    error.statusCode = 400;
    throw error;
  }
  const saved = [];
  for (const [index, item] of rows.entries()) {
    const payload = normalizePackagePayload(item, index, req.user._id);
    const row = await PackagePricing.findOneAndUpdate(
      { slug: payload.slug },
      payload,
      { upsert: true, new: true, runValidators: true }
    );
    saved.push(row);
  }
  await Setting.findOneAndUpdate(
    { key: "packages" },
    { value: saved.map(publicPackage), updatedBy: req.user._id },
    { upsert: true, new: true }
  );
  res.json({ ok: true, packages: saved.map(publicPackage) });
}));

router.patch("/pricing/:slug", asyncHandler(async (req, res) => {
  const payload = normalizePackagePayload({ ...req.body, slug: req.params.slug }, 0, req.user._id);
  const row = await PackagePricing.findOneAndUpdate(
    { slug: req.params.slug },
    payload,
    { upsert: true, new: true, runValidators: true }
  );
  const packages = await PackagePricing.find().sort({ displayOrder: 1, createdAt: 1 });
  await Setting.findOneAndUpdate(
    { key: "packages" },
    { value: packages.map(publicPackage), updatedBy: req.user._id },
    { upsert: true, new: true }
  );
  res.json({ ok: true, package: publicPackage(row), packages: packages.map(publicPackage) });
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
