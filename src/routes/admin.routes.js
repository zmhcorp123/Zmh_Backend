const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { ApprovalLog, Booking, EmailHistory, Invoice, Notification, OrderProgress, Otp, PackagePricing, PaymentSubmission, Setting, SupportTicket, User } = require("../models");
const { sendEmail } = require("../config/email");
const { EMAIL_ADDRESSES, EMAIL_SENDERS } = require("../config/emailConfig");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const { validateEmail } = require("../utils/validateEmail");

const router = express.Router();

router.use(requireAuth);

const ADMIN_LIST_LIMIT = 100;
const EMPLOYEE_PROGRESS_STATUSES = ["inquiry", "planned", "in progress", "completed", "blocked"];

function employeeOrAdmin(req, _res, next) {
  if (req.user?.role === "admin") return next();
  if (req.user?.role === "employee") {
    if (req.user.mustChangePassword || !req.user.isEmailVerified) {
      const error = new Error("Employee setup is required before accessing orders");
      error.statusCode = 403;
      return next(error);
    }
    return next();
  }
  const error = new Error("Staff access required");
  error.statusCode = 403;
  return next(error);
}

function staffSummary(summary) {
  return {
    ...summary,
    billing: { ...(summary.billing || {}), invoices: [] },
    accountDetails: {},
  };
}

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
    iban: "",
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
    iban: cleanString(value.iban, defaults.iban),
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
    OrderProgress.find({ order: order._id }).populate("admin", "name email").sort({ happenedAt: -1 }).lean(),
    Invoice.find({ $or: invoiceFilters }).sort({ createdAt: -1 }).limit(20).lean(),
    Setting.findOne({ key: "accountDetails" }).lean(),
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

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "Not selected";
}

function numericPrice(value) {
  const amount = Number(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function invoiceMeta(order, summary) {
  const invoice = summary.billing.invoices?.[0];
  const year = new Date(order.createdAt || Date.now()).getFullYear();
  const reference = `${summary.accountDetails.referencePrefix}-${String(order._id).slice(-8).toUpperCase()}`;
  const invoiceNumber = invoice?.invoice || `INV-${year}-${String(order._id).slice(-6).toUpperCase()}`;
  const subtotal = invoice?.amount || numericPrice(summary.package.price);
  return {
    invoiceNumber,
    reference,
    issueDate: formatDate(new Date()),
    dueDate: formatDate(invoice?.dueDate || order.nextBillingDate),
    subtotal,
    discount: 0,
    tax: 0,
    total: subtotal,
    amountPaid: summary.billing.paymentStatus === "paid" ? subtotal : 0,
    outstanding: summary.billing.paymentStatus === "paid" ? 0 : subtotal,
    currency: invoice?.currency || "USD",
    paymentTerms: "Due on receipt unless otherwise stated",
    preparedBy: "ZMH USA Corp Sales Team",
  };
}

async function ensureOrderInvoice(order, summary) {
  const meta = invoiceMeta(order, summary);
  const userId = order.user?._id || order.user || null;
  let invoice = await Invoice.findOne({ invoice: meta.invoiceNumber });
  const invoicePayload = {
    user: userId,
    company: order.companyName,
    amount: Number(meta.total || 0),
    currency: meta.currency || "USD",
    status: order.paymentStatus === "paid" ? "paid" : "sent",
    dueDate: order.nextBillingDate || null,
    lineItems: [{
      label: summary.package.name || "Service package",
      amount: Number(meta.total || 0),
    }],
    message: `Invoice summary sent for ${order.companyName}.`,
  };

  if (!invoice) {
    return Invoice.create({ ...invoicePayload, invoice: meta.invoiceNumber });
  }

  let changed = false;
  if (!invoice.user && userId) {
    invoice.user = userId;
    changed = true;
  }
  if (!invoice.company) {
    invoice.company = invoicePayload.company;
    changed = true;
  }
  if (!invoice.amount) {
    invoice.amount = invoicePayload.amount;
    changed = true;
  }
  if (!invoice.currency) {
    invoice.currency = invoicePayload.currency;
    changed = true;
  }
  if (!invoice.dueDate && invoicePayload.dueDate) {
    invoice.dueDate = invoicePayload.dueDate;
    changed = true;
  }
  if (!invoice.lineItems?.length) {
    invoice.lineItems = invoicePayload.lineItems;
    changed = true;
  }
  if (!invoice.message) {
    invoice.message = invoicePayload.message;
    changed = true;
  }
  if (invoice.status === "draft") {
    invoice.status = invoicePayload.status;
    changed = true;
  }
  return changed ? invoice.save() : invoice;
}

function chunkText(text, length = 72) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (`${line} ${word}`.trim().length > length) {
      if (line) lines.push(line);
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function createSummaryPdfBuffer(order, summary) {
  const meta = invoiceMeta(order, summary);
  const pageCount = 8;
  const brand = { blue: "0.04 0.35 1", green: "0.09 0.77 0.50", dark: "0.06 0.09 0.16", muted: "0.38 0.43 0.51", orange: "0.98 0.45 0.08", red: "0.86 0.15 0.15", light: "0.96 0.98 1" };
  const statusColor = (status = "") => status === "completed" || status === "paid" ? brand.green : status === "blocked" || status === "overdue" ? brand.red : status === "in progress" || status === "sent" ? brand.blue : brand.orange;
  const services = summary.package.servicesIncluded.length ? summary.package.servicesIncluded : ["Custom operations support"];
  const completed = summary.servicesCompleted.length ? summary.servicesCompleted : ["Progress updates pending"];
  const remaining = summary.servicesRemaining.length ? summary.servicesRemaining : ["Remaining scope to be confirmed"];
  const progressValue = Math.max(0, Math.min(100, Number(summary.currentProgress) || 0));
  const healthScore = progressValue >= 80 ? 96 : progressValue >= 50 ? 88 : progressValue >= 20 ? 76 : 68;

  const op = {
    text: (x, y, text, size = 10, font = "F1", color = brand.dark) => `${color} rg BT /${font} ${size} Tf ${x} ${y} Td (${pdfEscape(String(text).slice(0, 110))}) Tj ET`,
    rect: (x, y, w, h, color = "1 1 1", stroke = "0.86 0.89 0.94") => `${color} rg ${x} ${y} ${w} ${h} re f ${stroke} RG ${x} ${y} ${w} ${h} re S`,
    line: (x1, y1, x2, y2, color = "0.86 0.89 0.94", width = 1) => `${color} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S`,
    pill: (x, y, text, color = brand.blue) => [`${color} rg ${x} ${y} 118 22 re f`, op.text(x + 10, y + 7, text, 9, "F2", "1 1 1")].join("\n"),
    progress: (x, y, w, pct, color = brand.green) => [`0.90 0.94 1 rg ${x} ${y} ${w} 9 re f`, `${color} rg ${x} ${y} ${Math.max(4, w * pct / 100)} 9 re f`].join("\n"),
    footer: (page) => [op.line(42, 44, 570, 44), op.text(42, 28, "ZMH USA Corp | sales@zmhusacorp.com | zmhusacorp.com", 8, "F1", brand.muted), op.text(532, 28, `Page ${page} / ${pageCount}`, 8, "F2", brand.muted)].join("\n"),
    header: (title, page) => [`${brand.blue} rg 0 754 612 38 re f`, `${brand.green} rg 448 754 164 38 re f`, op.text(42, 768, "ZMH USA Corp", 13, "F2", "1 1 1"), op.text(42, 724, title, 24, "F2", brand.dark), op.footer(page)].join("\n"),
  };

  const field = (x, y, label, value) => [op.text(x, y + 18, label, 8, "F2", brand.muted), op.text(x, y, value || "Not provided", 11, "F2", brand.dark)].join("\n");
  const barcode = (x, y, seed) => Array.from({ length: 34 }, (_, index) => `${brand.dark} rg ${x + index * 5} ${y} ${((seed.charCodeAt(index % seed.length) || 3) % 3) + 1} 46 re f`).join("\n");

  const page1 = [
    `${brand.blue} rg 0 610 612 182 re f`, `${brand.green} rg 384 610 228 182 re f`,
    op.text(48, 712, "ZMH USA Corp", 30, "F2", "1 1 1"),
    op.text(48, 670, "Invoice & Service Summary", 34, "F2", "1 1 1"),
    op.text(48, 646, "Executive service, billing, and operational progress report", 13, "F1", "0.88 0.94 1"),
    op.rect(42, 392, 528, 168, "1 1 1"),
    field(64, 520, "Invoice Number", meta.invoiceNumber), field(244, 520, "Order Reference", meta.reference), field(424, 520, "Issue Date", meta.issueDate),
    field(64, 472, "Due Date", meta.dueDate), field(244, 472, "Prepared By", meta.preparedBy), field(424, 472, "Client Company", summary.company.name),
    field(64, 424, "Contact Person", summary.company.contactPerson), field(244, 424, "Package", summary.package.name), field(424, 424, "Current Status", order.status),
    op.pill(64, 340, `Payment: ${summary.billing.paymentStatus}`, statusColor(summary.billing.paymentStatus)),
    op.pill(204, 340, `Progress: ${progressValue}%`, brand.blue),
    op.pill(344, 340, `Package: ${summary.package.name}`, brand.green),
    op.text(64, 260, "Confidential client document prepared for executive review.", 16, "F2"),
    op.footer(1),
  ].join("\n");

  const clientFields = [
    ["Company", summary.company.name], ["Contact Person", summary.company.contactPerson], ["Email", summary.company.email], ["Phone", summary.company.phone],
    ["Website", summary.company.website], ["Address", summary.company.address], ["Industry", order.businessType || "Home services"], ["Package Purchased", summary.package.name],
    ["Monthly Price", summary.package.price], ["Contract Start", formatDate(order.serviceStartDate || order.createdAt)], ["Renewal Date", formatDate(order.nextBillingDate)], ["Next Billing Date", formatDate(order.nextBillingDate)],
    ["Current Progress", `${progressValue}%`], ["Dedicated Account Manager", order.assignedStaff || "ZMH Client Success"],
  ];
  const page2 = [op.header("Client Information", 2), ...clientFields.map(([label, value], index) => {
    const col = index % 2; const row = Math.floor(index / 2); const x = col ? 316 : 48; const y = 654 - row * 72;
    return [op.rect(x, y - 22, 248, 52, "1 1 1"), field(x + 16, y, label, value)].join("\n");
  })].join("\n");

  const serviceCards = services.slice(0, 9).map((service, index) => {
    const col = index % 3; const row = Math.floor(index / 3); const x = 48 + col * 174; const y = 548 - row * 128;
    const done = summary.servicesCompleted.some((item) => item.toLowerCase().includes(String(service).toLowerCase()));
    return [op.rect(x, y, 158, 104, "1 1 1"), op.text(x + 14, y + 76, "●", 18, "F2", done ? brand.green : brand.blue), op.text(x + 38, y + 80, service, 11, "F2"), op.text(x + 14, y + 58, done ? "Completed service milestone" : "Service delivery in progress", 8, "F1", brand.muted), op.progress(x + 14, y + 34, 126, done ? 100 : progressValue), op.text(x + 14, y + 18, done ? "Completed | 100%" : `${order.status} | ${progressValue}%`, 8, "F2", done ? brand.green : brand.blue)].join("\n");
  });
  const page3 = [op.header("Package Breakdown", 3), op.rect(48, 610, 516, 82, "1 1 1"), op.text(70, 660, summary.package.name, 24, "F2"), op.text(70, 634, `${summary.package.price} | Monthly operations support`, 14, "F2", brand.orange), op.pill(394, 642, order.status, statusColor(order.status)), ...serviceCards].join("\n");

  const timeline = (summary.timeline.length ? summary.timeline : [{ title: "Service timeline pending", description: "Progress updates will appear here after admin activity is recorded.", status: "planned", progressPercent: progressValue, happenedAt: new Date(), adminName: "ZMH Admin" }]).slice(0, 8);
  const page4 = [op.header("Service Progress", 4), ...timeline.map((item, index) => {
    const y = 650 - index * 72; const color = statusColor(item.status);
    return [op.line(70, y - 42, 70, y + 22, "0.82 0.86 0.92", 2), `${color} rg 62 ${y + 6} 16 16 re f`, op.text(92, y + 14, `${formatDate(item.happenedAt)} | ${item.adminName || item.admin?.name || "Admin"}`, 8, "F2", brand.muted), op.text(92, y, item.title, 12, "F2"), op.text(92, y - 16, chunkText(item.description || "No description provided.", 74)[0], 8, "F1", brand.muted), op.progress(426, y - 2, 92, item.progressPercent || 0, color), op.text(526, y - 4, `${item.progressPercent || 0}%`, 8, "F2", color)].join("\n");
  })].join("\n");

  const page5 = [op.header("Service Analytics", 5), op.rect(48, 560, 160, 120, "1 1 1"), op.text(78, 632, `${progressValue}%`, 34, "F2", brand.blue), op.text(78, 608, "Completion", 12, "F2"), op.progress(78, 590, 100, progressValue), op.rect(226, 560, 160, 120, "1 1 1"), op.text(256, 632, `${100 - progressValue}%`, 34, "F2", brand.orange), op.text(256, 608, "Remaining", 12, "F2"), op.rect(404, 560, 160, 120, "1 1 1"), op.text(434, 632, `${healthScore}`, 34, "F2", brand.green), op.text(434, 608, "Health Score", 12, "F2"), op.text(48, 500, "Completed Services", 16, "F2"), ...completed.slice(0, 8).map((item, i) => op.text(64, 474 - i * 22, `✓ ${item}`, 10, "F2", brand.green)), op.text(316, 500, "Remaining Services", 16, "F2"), ...remaining.slice(0, 8).map((item, i) => op.text(332, 474 - i * 22, `• ${item}`, 10, "F2", brand.blue)), op.rect(48, 150, 516, 78, "1 1 1"), field(70, 188, "Current Milestone", completed[0] || "Initial setup"), field(260, 188, "Next Milestone", remaining[0] || "Executive review"), field(438, 188, "Estimated Completion", progressValue >= 100 ? "Completed" : "In progress")].join("\n");

  const invoiceRows = [["Package", summary.package.name], ["Subtotal", `${meta.currency} ${meta.subtotal.toFixed(2)}`], ["Discount", `${meta.currency} ${meta.discount.toFixed(2)}`], ["Tax", `${meta.currency} ${meta.tax.toFixed(2)}`], ["Total", `${meta.currency} ${meta.total.toFixed(2)}`], ["Amount Paid", `${meta.currency} ${meta.amountPaid.toFixed(2)}`], ["Outstanding Balance", `${meta.currency} ${meta.outstanding.toFixed(2)}`], ["Payment Terms", meta.paymentTerms], ["Reference Number", meta.reference]];
  const page6 = [op.header("Invoice Summary", 6), op.rect(48, 594, 516, 92, "1 1 1"), field(70, 652, "Invoice Number", meta.invoiceNumber), field(260, 652, "Currency", meta.currency), field(420, 652, "Payment Status", summary.billing.paymentStatus), op.pill(420, 612, summary.billing.paymentStatus, statusColor(summary.billing.paymentStatus)), ...invoiceRows.map(([label, value], i) => [op.line(70, 560 - i * 36, 382, 560 - i * 36), op.text(74, 542 - i * 36, label, 10, "F2", brand.muted), op.text(246, 542 - i * 36, value, 10, "F2", brand.dark)].join("\n")), op.rect(420, 368, 112, 112, "1 1 1"), op.text(438, 444, "Invoice Reference", 11, "F2", brand.muted), op.text(438, 420, meta.reference, 10, "F2", brand.dark), barcode(420, 270, meta.invoiceNumber), op.text(420, 252, "Barcode", 9, "F2", brand.muted)].join("\n");

  const bankRows = [["Beneficiary Name", summary.accountDetails.beneficiaryName], ["Bank Name", summary.accountDetails.bankName], ["Account Number", summary.accountDetails.accountNumber], ["Routing Number", summary.accountDetails.routingNumber || "Provided on request"], ["IBAN", summary.accountDetails.iban || "Not provided"], ["SWIFT", summary.accountDetails.swiftCode || "Provided on request"], ["Branch", summary.accountDetails.branchName || "Not provided"], ["Bank Address", summary.accountDetails.bankAddress || "Not provided"], ["Payment Reference", meta.reference], ["Payment Instructions", summary.accountDetails.paymentInstructions]];
  const page7 = [op.header("Bank Transfer Details", 7), ...bankRows.map(([label, value], index) => {
    const y = 650 - index * 52;
    return [op.rect(48, y - 20, 516, 42, index % 2 ? "0.98 0.99 1" : "1 1 1"), op.text(66, y + 4, label, 9, "F2", brand.muted), op.text(238, y + 2, value, 10, "F2")].join("\n");
  }), op.rect(48, 84, 516, 60, "1 1 1"), op.text(66, 118, "Important Notes", 12, "F2"), op.text(66, 98, "Use the payment reference exactly as shown to avoid posting delays. Contact sales@zmhusacorp.com for support.", 9, "F1", brand.muted)].join("\n");

  const page8 = [op.header("Company Information", 8), op.text(48, 664, "About ZMH USA Corp", 24, "F2"), ...chunkText("ZMH USA Corp provides remote operations support for home service companies, helping teams manage calls, dispatch, customer support, CRM workflows, billing coordination, and service reporting with professional operating discipline.", 88).map((line, i) => op.text(48, 632 - i * 16, line, 10, "F1", brand.muted)), op.rect(48, 472, 516, 94, "1 1 1"), field(70, 532, "Mission", "Make premium remote operations accessible to growing service companies."), field(70, 488, "Website", "zmhusacorp.com"), field(250, 488, "Support Email", "support@zmhusacorp.com"), field(430, 488, "Sales Email", "sales@zmhusacorp.com"), op.rect(48, 300, 240, 92, "1 1 1"), field(70, 350, "Phone", "+1 (555) 018-2048"), field(70, 314, "Business Hours", "Monday-Friday, 9 AM-6 PM ET"), op.rect(324, 284, 180, 92, "1 1 1"), field(344, 338, "Website", "zmhusacorp.com"), field(344, 302, "Dashboard", "Client portal access"), op.text(48, 220, "Thank you for choosing ZMH USA Corp.", 20, "F2", brand.blue)].join("\n");

  const contents = [page1, page2, page3, page4, page5, page6, page7, page8];
  const pageObjectStart = 6;
  const contentObjectStart = pageObjectStart + contents.length;
  const pageRefs = contents.map((_, index) => `${pageObjectStart + index} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageRefs}] /Count ${contents.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    ...contents.map((_, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentObjectStart + index} 0 R >>`),
    ...contents.map((content) => `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`),
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

function createExecutiveSummaryPdfBuffer(order, summary) {
  const meta = invoiceMeta(order, summary);
  const brand = {
    blue: "0.04 0.35 1",
    green: "0.09 0.77 0.50",
    dark: "0.06 0.09 0.16",
    muted: "0.38 0.43 0.51",
    orange: "0.98 0.45 0.08",
    red: "0.86 0.15 0.15",
    line: "0.86 0.89 0.94",
    white: "1 1 1",
  };
  const services = summary.package.servicesIncluded.length ? summary.package.servicesIncluded : ["Custom operations support"];
  const completed = summary.servicesCompleted || [];
  const remaining = summary.servicesRemaining.length ? summary.servicesRemaining : services.filter((service) => !completed.some((done) => done.toLowerCase().includes(String(service).toLowerCase())));
  const invoices = summary.billing.invoices || [];
  const files = order.filesUploaded || [];
  const progressValue = Math.max(0, Math.min(100, Number(summary.currentProgress) || 0));
  const pageCount = 3;
  const statusColor = (status = "") => {
    const value = String(status).toLowerCase();
    if (["paid", "completed", "approved"].includes(value)) return brand.green;
    if (["overdue", "blocked", "cancelled", "payment rejected"].includes(value)) return brand.red;
    if (["sent", "ongoing", "in progress", "payment submitted"].includes(value)) return brand.blue;
    return brand.orange;
  };
  const op = {
    text: (x, y, value, size = 10, font = "F1", color = brand.dark, limit = 90) => `${color} rg BT /${font} ${size} Tf ${x} ${y} Td (${pdfEscape(String(value || "").slice(0, limit))}) Tj ET`,
    rect: (x, y, w, h, fill = brand.white, stroke = brand.line) => `${fill} rg ${x} ${y} ${w} ${h} re f ${stroke} RG ${x} ${y} ${w} ${h} re S`,
    line: (x1, y1, x2, y2, color = brand.line, width = 1) => `${color} RG ${width} w ${x1} ${y1} m ${x2} ${y2} l S`,
    footer: (page) => [op.line(36, 38, 576, 38), op.text(36, 22, "ZMH USA Corp | sales@zmhusacorp.com | zmhusacorp.com", 8, "F1", brand.muted), op.text(536, 22, `Page ${page} / ${pageCount}`, 8, "F2", brand.muted)].join("\n"),
    pill: (x, y, value, fill = brand.blue, w = 120) => [`${fill} rg ${x} ${y} ${w} 22 re f`, op.text(x + 10, y + 7, value, 8.5, "F2", brand.white, 34)].join("\n"),
    progress: (x, y, w, pct, color = brand.green) => [`0.90 0.94 1 rg ${x} ${y} ${w} 10 re f`, `${color} rg ${x} ${y} ${Math.max(4, w * pct / 100)} 10 re f`].join("\n"),
  };
  const logo = (x, y) => [op.rect(x, y, 42, 42, brand.blue, brand.blue), op.text(x + 13, y + 13, "Z", 20, "F2", brand.white)].join("\n");
  const title = (x, y, value) => [op.text(x, y, value, 15, "F2"), `${brand.blue} rg ${x} ${y - 8} 28 3 re f`].join("\n");
  const card = (x, y, w, h, label, value, color = brand.blue) => [op.rect(x + 2, y - 2, w, h, "0.89 0.92 0.96", "0.89 0.92 0.96"), op.rect(x, y, w, h), `${color} rg ${x} ${y + h - 4} ${w} 4 re f`, op.text(x + 12, y + h - 22, label, 7.5, "F2", brand.muted, 28), op.text(x + 12, y + 15, value || "Not provided", 12, "F2", brand.dark, 34)].join("\n");
  const miniCard = (x, y, w, h, label, value, color = brand.blue) => [op.rect(x, y, w, h), op.text(x + 10, y + h - 18, label, 7, "F2", brand.muted, 24), op.text(x + 10, y + 13, value || "Not provided", 10, "F2", color, 34)].join("\n");
  const chip = (x, y, w, value, color = brand.blue, fill = "0.94 0.97 1") => [op.rect(x, y, w, 32, fill, "0.82 0.87 0.94"), op.text(x + 9, y + 11, value, 8.2, "F2", color, 34)].join("\n");
  const timeline = (items, x, y, max = 4) => (items.length ? items : [{ title: "Service timeline pending", status: "planned", progressPercent: progressValue, happenedAt: new Date() }]).slice(0, max).map((item, index) => {
    const rowY = y - index * 44;
    const color = statusColor(item.status);
    return [op.line(x + 8, rowY - 28, x + 8, rowY + 8, brand.line, 1.4), `${color} rg ${x + 3} ${rowY + 3} 10 10 re f`, op.text(x + 24, rowY + 5, item.title, 8.8, "F2", brand.dark, 44), op.text(x + 24, rowY - 10, `${formatDate(item.happenedAt)} | ${item.status || "planned"} | ${item.progressPercent || 0}%`, 7.2, "F1", brand.muted, 48)].join("\n");
  }).join("\n");
  const ring = (cx, cy, pct) => {
    const ops = [];
    const active = Math.round(20 * pct / 100);
    for (let index = 0; index < 20; index += 1) {
      const angle = (Math.PI * 2 * index / 20) - Math.PI / 2;
      ops.push(`${index < active ? brand.green : "0.86 0.90 0.96"} rg ${(cx + Math.cos(angle) * 42).toFixed(1)} ${(cy + Math.sin(angle) * 42).toFixed(1)} 8 8 re f`);
    }
    return [...ops, op.rect(cx - 29, cy - 29, 66, 66, brand.white, brand.white), op.text(cx - 23, cy + 2, `${pct}%`, 22, "F2", brand.blue), op.text(cx - 24, cy - 15, "complete", 8, "F2", brand.muted)].join("\n");
  };

  const companyRows = [
    ["Company", summary.company.name],
    ["Contact Person", summary.company.contactPerson || order.user?.name || "Client"],
    ["Email", summary.company.email || order.email || order.user?.email],
    ["Phone", summary.company.phone || order.phone],
    ["Website", summary.company.website || order.website],
    ["Address", summary.company.address || order.address],
    ["Industry", order.businessType || "Home services"],
    ["Package", summary.package.name],
    ["Package Price", summary.package.price],
    ["Manager", order.assignedStaff || "ZMH Team"],
    ["Service Start", formatDate(order.serviceStartDate || order.createdAt)],
    ["Next Billing", formatDate(order.nextBillingDate)],
  ];
  const invoiceRows = [
    ["Invoice Number", meta.invoiceNumber],
    ["Reference", meta.reference],
    ["Issue Date", meta.issueDate],
    ["Due Date", meta.dueDate],
    ["Subtotal", `${meta.currency} ${meta.subtotal.toFixed(2)}`],
    ["Discount", `${meta.currency} ${meta.discount.toFixed(2)}`],
    ["Tax", `${meta.currency} ${meta.tax.toFixed(2)}`],
    ["Total", `${meta.currency} ${meta.total.toFixed(2)}`],
    ["Paid", `${meta.currency} ${meta.amountPaid.toFixed(2)}`],
    ["Remaining", `${meta.currency} ${meta.outstanding.toFixed(2)}`],
    ["Invoice Status", invoices[0]?.status || "sent"],
    ["Payment Status", summary.billing.paymentStatus],
  ];
  const bankRows = [
    ["Beneficiary", summary.accountDetails.beneficiaryName],
    ["Bank", summary.accountDetails.bankName],
    ["Account", summary.accountDetails.accountNumber],
    ["Routing", summary.accountDetails.routingNumber || "Provided on request"],
    ["SWIFT", summary.accountDetails.swiftCode || "Provided on request"],
    ["Reference", meta.reference],
  ];

  const page1 = [
    op.rect(0, 0, 612, 792, "0.96 0.98 1", "0.96 0.98 1"),
    op.rect(0, 632, 612, 160, brand.dark, brand.dark),
    `${brand.dark} rg 420 632 192 160 re f`,
    logo(38, 704),
    op.text(92, 728, "ZMH USA Corp", 18, "F2", brand.white),
    op.text(92, 700, "Company Details", 28, "F2", brand.white, 28),
    op.text(92, 674, "Single client profile for billing and service review", 10.5, "F1", "0.82 0.91 1", 58),
    op.pill(438, 718, meta.invoiceNumber, brand.white, 134), op.text(452, 725, meta.invoiceNumber, 8.5, "F2", brand.blue, 30),
    op.pill(438, 682, `Payment: ${summary.billing.paymentStatus}`, statusColor(summary.billing.paymentStatus), 134),
    title(38, 586, "Company Information"),
    ...companyRows.map(([label, value], index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      return miniCard(38 + col * 276, 526 - row * 66, 258, 52, label, value || "Not provided", col ? brand.green : brand.blue);
    }),
    op.rect(38, 92, 536, 78),
    op.text(56, 142, "ZMH Contact", 13, "F2"),
    op.text(56, 120, "sales@zmhusacorp.com | support@zmhusacorp.com | zmhusacorp.com", 9, "F2", brand.blue, 80),
    op.footer(1),
  ].join("\n");

  const page2 = [
    op.rect(0, 0, 612, 792, "0.96 0.98 1", "0.96 0.98 1"),
    logo(36, 742), op.text(88, 760, "ZMH USA Corp", 13, "F2"), op.text(88, 744, meta.invoiceNumber, 9, "F2", brand.muted),
    title(36, 718, "Bill Summary"),
    ...invoiceRows.map(([label, value], index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const color = label.includes("Status") || label === "Remaining" ? statusColor(String(value)) : brand.blue;
      return miniCard(36 + col * 276, 650 - row * 58, 258, 46, label, value || "Not provided", color);
    }),
    title(36, 276, "Bank Transfer Details"),
    ...bankRows.map(([label, value], index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      return miniCard(36 + col * 276, 212 - row * 52, 258, 42, label, value || "Not provided", brand.dark);
    }),
    op.text(36, 64, "Please include the invoice reference with bank transfers to avoid posting delays.", 8.8, "F1", brand.muted, 96),
    op.footer(2),
  ].join("\n");

  const contents = [page1, page2];
  const pageObjectStart = 6;
  const contentObjectStart = pageObjectStart + contents.length;
  const pageRefs = contents.map((_, index) => `${pageObjectStart + index} 0 R`).join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageRefs}] /Count ${contents.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    ...contents.map((_, index) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentObjectStart + index} 0 R >>`),
    ...contents.map((content) => `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`),
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

function buildExecutiveSummaryEmail(order, summary) {
  const meta = invoiceMeta(order, summary);
  const subject = `ZMH USA Corp | Executive Invoice Summary | ${order.companyName} | ${meta.invoiceNumber}`;
  const progress = Math.max(0, Math.min(100, Number(summary.currentProgress) || 0));
  const amount = `${meta.currency} ${meta.total.toFixed(2)}`;
  const html = `
    <div style="margin:0;padding:0;background:#eef4ff;font-family:Inter,Segoe UI,Arial,sans-serif;color:#172033">
      <div style="max-width:720px;margin:0 auto;padding:28px">
        <div style="background:linear-gradient(135deg,#0f172a,#0b5fff 62%,#16c47f);color:white;border-radius:24px 24px 0 0;padding:34px">
          <div style="display:inline-flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:16px;background:rgba(255,255,255,.18);font-size:24px;font-weight:900">Z</div>
          <h1 style="margin:20px 0 8px;font-size:30px;line-height:1.12">Executive Invoice & Service Summary</h1>
          <p style="margin:0;color:#eaf1ff;font-size:15px">A premium PDF report is attached for ${escapeHtml(order.companyName)}.</p>
        </div>
        <div style="background:white;border:1px solid #dce3ee;border-top:0;border-radius:0 0 24px 24px;padding:28px">
          <p style="margin:0 0 18px;color:#667085;line-height:1.7">Your attached document combines invoice status, service delivery progress, banking details, and operational updates into a concise executive report.</p>
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:22px 0">
            <div style="padding:16px;border:1px solid #edf1f7;border-radius:16px;background:#f8fbff"><strong style="display:block;color:#667085;font-size:12px;text-transform:uppercase">Invoice Number</strong><span style="display:block;margin-top:6px;font-size:20px;font-weight:900">${escapeHtml(meta.invoiceNumber)}</span></div>
            <div style="padding:16px;border:1px solid #edf1f7;border-radius:16px;background:#f8fbff"><strong style="display:block;color:#667085;font-size:12px;text-transform:uppercase">Amount</strong><span style="display:block;margin-top:6px;font-size:20px;font-weight:900;color:#f97316">${escapeHtml(amount)}</span></div>
            <div style="padding:16px;border:1px solid #edf1f7;border-radius:16px;background:#f8fbff"><strong style="display:block;color:#667085;font-size:12px;text-transform:uppercase">Package</strong><span style="display:block;margin-top:6px;font-size:18px;font-weight:900">${escapeHtml(summary.package.name)}</span></div>
            <div style="padding:16px;border:1px solid #edf1f7;border-radius:16px;background:#f8fbff"><strong style="display:block;color:#667085;font-size:12px;text-transform:uppercase">Payment Status</strong><span style="display:block;margin-top:6px;font-size:18px;font-weight:900;color:#0b5fff">${escapeHtml(summary.billing.paymentStatus)}</span></div>
            <div style="padding:16px;border:1px solid #edf1f7;border-radius:16px;background:#f8fbff"><strong style="display:block;color:#667085;font-size:12px;text-transform:uppercase">Progress</strong><span style="display:block;margin-top:6px;font-size:18px;font-weight:900;color:#16c47f">${progress}% complete</span></div>
            <div style="padding:16px;border:1px solid #edf1f7;border-radius:16px;background:#f8fbff"><strong style="display:block;color:#667085;font-size:12px;text-transform:uppercase">Next Billing</strong><span style="display:block;margin-top:6px;font-size:18px;font-weight:900">${escapeHtml(formatDate(order.nextBillingDate))}</span></div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:10px;margin:24px 0">
            <a href="https://zmhusacorp.com/user-dashboard" style="display:inline-block;padding:12px 16px;border-radius:12px;background:#0b5fff;color:white;text-decoration:none;font-weight:800">View Dashboard</a>
            <a href="https://zmhusacorp.com/invoices" style="display:inline-block;padding:12px 16px;border-radius:12px;background:#eef4ff;color:#0b5fff;text-decoration:none;font-weight:800">Download Invoice</a>
            <a href="https://zmhusacorp.com/book-meeting" style="display:inline-block;padding:12px 16px;border-radius:12px;background:#eef4ff;color:#0b5fff;text-decoration:none;font-weight:800">Book Meeting</a>
            <a href="mailto:support@zmhusacorp.com" style="display:inline-block;padding:12px 16px;border-radius:12px;background:#eef4ff;color:#0b5fff;text-decoration:none;font-weight:800">Contact Support</a>
          </div>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #edf1f7;color:#667085;font-size:13px">ZMH USA Corp | sales@zmhusacorp.com | zmhusacorp.com</div>
        </div>
      </div>
    </div>`;
  const text = `Invoice ${meta.invoiceNumber}. Package: ${summary.package.name}. Amount: ${amount}. Payment: ${summary.billing.paymentStatus}. Progress: ${progress}%. Next billing: ${formatDate(order.nextBillingDate)}.`;
  return { subject, html, text };
}

function buildSummaryEmail(order, summary) {
  const meta = invoiceMeta(order, summary);
  const subject = `ZMH USA Corp | Invoice & Service Summary | ${order.companyName} | ${meta.invoiceNumber}`;
  const outstanding = `${meta.currency} ${meta.outstanding.toFixed(2)}`;
  const progress = Math.max(0, Math.min(100, Number(summary.currentProgress) || 0));
  const html = `
    <div style="margin:0;padding:0;background:#eef4ff;font-family:Inter,Segoe UI,Arial,sans-serif;color:#172033">
      <div style="display:none;max-height:0;overflow:hidden">Your premium ZMH invoice and service summary is attached.</div>
      <div style="max-width:720px;margin:0 auto;padding:28px">
        <div style="background:linear-gradient(135deg,#0b5fff,#16c47f);color:white;border-radius:24px 24px 0 0;padding:34px">
          <div style="display:inline-flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:16px;background:rgba(255,255,255,.18);font-size:24px;font-weight:900">Z</div>
          <h1 style="margin:20px 0 8px;font-size:30px;line-height:1.12">Invoice & Service Summary</h1>
          <p style="margin:0;color:#eaf1ff;font-size:15px">Prepared for ${escapeHtml(order.companyName)} by ZMH USA Corp.</p>
        </div>
        <div style="background:white;border:1px solid #dce3ee;border-top:0;border-radius:0 0 24px 24px;padding:28px">
          <p style="margin:0 0 14px;font-size:16px">Hi ${escapeHtml(summary.company.contactPerson || order.companyName)},</p>
          <p style="margin:0 0 22px;color:#667085;line-height:1.7">Your latest enterprise invoice and service summary is attached as a premium PDF. The document includes service progress, invoice details, banking instructions, analytics, and timeline history.</p>
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:22px 0">
            <div style="padding:16px;border:1px solid #edf1f7;border-radius:16px;background:#f8fbff"><strong style="display:block;color:#667085;font-size:12px;text-transform:uppercase">Invoice</strong><span style="display:block;margin-top:6px;font-size:20px;font-weight:900">${escapeHtml(meta.invoiceNumber)}</span></div>
            <div style="padding:16px;border:1px solid #edf1f7;border-radius:16px;background:#f8fbff"><strong style="display:block;color:#667085;font-size:12px;text-transform:uppercase">Outstanding</strong><span style="display:block;margin-top:6px;font-size:20px;font-weight:900;color:#f97316">${escapeHtml(outstanding)}</span></div>
            <div style="padding:16px;border:1px solid #edf1f7;border-radius:16px;background:#f8fbff"><strong style="display:block;color:#667085;font-size:12px;text-transform:uppercase">Package</strong><span style="display:block;margin-top:6px;font-size:18px;font-weight:900">${escapeHtml(summary.package.name)}</span></div>
            <div style="padding:16px;border:1px solid #edf1f7;border-radius:16px;background:#f8fbff"><strong style="display:block;color:#667085;font-size:12px;text-transform:uppercase">Progress</strong><span style="display:block;margin-top:6px;font-size:18px;font-weight:900;color:#0b5fff">${progress}% complete</span></div>
          </div>
          <div style="margin:20px 0;padding:18px;border-radius:18px;background:#0f172a;color:white">
            <strong style="display:block;font-size:16px">Service Summary</strong>
            <p style="margin:8px 0 0;color:#dbe7ff;line-height:1.65">Completed: ${escapeHtml(summary.servicesCompleted.join(", ") || "Progress updates are being prepared.")}</p>
            <p style="margin:8px 0 0;color:#dbe7ff;line-height:1.65">Remaining: ${escapeHtml(summary.servicesRemaining.join(", ") || "No remaining services listed.")}</p>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:10px;margin:24px 0">
            <a href="https://zmhusacorp.com/invoices" style="display:inline-block;padding:12px 16px;border-radius:12px;background:#0b5fff;color:white;text-decoration:none;font-weight:800">Download Invoice</a>
            <a href="https://zmhusacorp.com/user-dashboard" style="display:inline-block;padding:12px 16px;border-radius:12px;background:#eef4ff;color:#0b5fff;text-decoration:none;font-weight:800">Visit Dashboard</a>
            <a href="https://zmhusacorp.com/book-meeting" style="display:inline-block;padding:12px 16px;border-radius:12px;background:#eef4ff;color:#0b5fff;text-decoration:none;font-weight:800">Book Meeting</a>
            <a href="mailto:sales@zmhusacorp.com" style="display:inline-block;padding:12px 16px;border-radius:12px;background:#eef4ff;color:#0b5fff;text-decoration:none;font-weight:800">Support</a>
          </div>
          <p style="margin:0;color:#667085;line-height:1.7">The PDF attachment contains your full invoice number, order summary, service timeline, banking instructions, and company contact details.</p>
          <p style="margin:24px 0 0">Best regards,<br /><strong>ZMH USA Corp Sales Team</strong></p>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #edf1f7;color:#667085;font-size:13px">sales@zmhusacorp.com | zmhusacorp.com | This email is optimized for light and dark mode clients.</div>
        </div>
      </div>
    </div>`;
  const text = `Hi ${summary.company.contactPerson || order.companyName}, your ZMH invoice and service summary PDF is attached. Invoice: ${meta.invoiceNumber}. Package: ${summary.package.name}. Progress: ${progress}%. Outstanding: ${outstanding}.`;
  return { subject, html, text };
}

function paymentPdfBuffer(invoice, payment, user) {
  const text = (x, y, value, size = 10, font = "F1", color = "0.10 0.14 0.22") => `BT /${font} ${size} Tf ${color} rg ${x} ${y} Td (${pdfEscape(value)}) Tj ET`;
  const rect = (x, y, w, h, color = "1 1 1") => `${color} rg ${x} ${y} ${w} ${h} re f`;
  const rows = [
    ["Invoice", invoice.invoice],
    ["Status", "Paid"],
    ["Client", user?.name || invoice.company],
    ["Company", invoice.company],
    ["Amount Received", `${invoice.currency} ${Number(invoice.amount || 0).toFixed(2)}`],
    ["Payment Date", formatDate(payment.paymentDate)],
    ["Transaction ID", payment.transactionId],
    ["Next Billing", "Shown in your client dashboard"],
  ];
  const content = [
    rect(0, 0, 612, 792, "0.97 0.98 1"),
    rect(0, 642, 612, 150, "0.04 0.11 0.24"),
    text(48, 716, "ZMH USA Corp", 26, "F2", "1 1 1"),
    text(48, 684, "Paid Invoice Confirmation", 20, "F2", "0.82 0.91 1"),
    rect(48, 500, 516, 112),
    ...rows.map(([label, value], index) => {
      const x = index % 2 ? 316 : 72;
      const y = 578 - Math.floor(index / 2) * 42;
      return [text(x, y, label, 8, "F2", "0.40 0.45 0.54"), text(x, y - 16, value, 11, "F2")].join("\n");
    }),
    rect(348, 328, 216, 72, "0.04 0.11 0.24"),
    text(370, 370, "Amount Paid", 11, "F1", "0.82 0.91 1"),
    text(370, 344, `${invoice.currency} ${Number(invoice.amount || 0).toFixed(2)}`, 22, "F2", "1 1 1"),
    text(48, 252, "Thank you for your payment. Your account has been updated and this invoice is now marked paid.", 12, "F1", "0.38 0.43 0.51"),
    text(48, 52, "ZMH USA Corp | support@zmhusacorp.com | sales@zmhusacorp.com", 9, "F1", "0.40 0.45 0.54"),
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

function paymentApprovalEmail(payment) {
  const user = payment.user;
  const invoice = payment.invoice;
  const order = payment.order;
  const amount = `${invoice.currency} ${Number(invoice.amount || payment.amount || 0).toFixed(2)}`;
  const subject = "Payment Received - Thank You";
  const html = `
    <div style="margin:0;background:#f4f7fb;padding:28px;font-family:Inter,Arial,sans-serif;color:#172033">
      <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e7edf6;border-radius:22px;overflow:hidden">
        <div style="padding:28px;background:#0f172a;color:white">
          <div style="font-weight:900;font-size:22px">ZMH USA Corp</div>
          <p style="margin:8px 0 0;color:#d8e6ff">Payment received and verified</p>
        </div>
        <div style="padding:28px">
          <h2 style="margin:0 0 12px">Thank you, ${escapeHtml(user.name)}</h2>
          <p style="line-height:1.7;color:#667085">We have verified your payment and updated your invoice status to paid.</p>
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">
            <div style="padding:14px;border:1px solid #edf1f7;border-radius:14px"><strong>Package</strong><br />${escapeHtml(order?.packageName || "ZMH Services")}</div>
            <div style="padding:14px;border:1px solid #edf1f7;border-radius:14px"><strong>Invoice</strong><br />${escapeHtml(invoice.invoice)}</div>
            <div style="padding:14px;border:1px solid #edf1f7;border-radius:14px"><strong>Amount Received</strong><br />${amount}</div>
            <div style="padding:14px;border:1px solid #edf1f7;border-radius:14px"><strong>Payment Date</strong><br />${formatDate(payment.paymentDate)}</div>
            <div style="padding:14px;border:1px solid #edf1f7;border-radius:14px"><strong>Transaction ID</strong><br />${escapeHtml(payment.transactionId)}</div>
            <div style="padding:14px;border:1px solid #edf1f7;border-radius:14px"><strong>Next Billing</strong><br />${formatDate(order?.nextBillingDate)}</div>
          </div>
          <p style="line-height:1.7;color:#667085">If you need help, contact support@zmhusacorp.com.</p>
        </div>
        <div style="padding:18px 28px;background:#f8fbff;color:#667085;font-size:13px">ZMH USA Corp | Premium remote operations support</div>
      </div>
    </div>`;
  const text = `Payment received. Invoice: ${invoice.invoice}. Amount: ${amount}. Transaction: ${payment.transactionId}.`;
  return { subject, html, text };
}

function paymentRejectedEmail(payment, reason) {
  const user = payment.user;
  const invoice = payment.invoice;
  const subject = "Payment could not be verified";
  const html = `
    <div style="margin:0;background:#f4f7fb;padding:28px;font-family:Inter,Arial,sans-serif;color:#172033">
      <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e7edf6;border-radius:22px;overflow:hidden">
        <div style="padding:28px;background:#0f172a;color:white"><div style="font-weight:900;font-size:22px">ZMH USA Corp</div><p style="margin:8px 0 0;color:#d8e6ff">Payment verification update</p></div>
        <div style="padding:28px">
          <h2 style="margin:0 0 12px">Hi ${escapeHtml(user.name)},</h2>
          <p style="line-height:1.7;color:#667085">We could not verify the payment submitted for invoice <strong>${escapeHtml(invoice.invoice)}</strong>.</p>
          <div style="padding:16px;border-radius:14px;background:#fff4f4;border:1px solid #ffd7d7"><strong>Reason</strong><br />${escapeHtml(reason || "The submitted payment details could not be matched.")}</div>
          <p style="line-height:1.7;color:#667085">Please review the bank transfer details, then resubmit your payment reference from your dashboard. Contact support@zmhusacorp.com if you need help.</p>
        </div>
        <div style="padding:18px 28px;background:#f8fbff;color:#667085;font-size:13px">ZMH USA Corp | support@zmhusacorp.com</div>
      </div>
    </div>`;
  const text = `Payment could not be verified for invoice ${invoice.invoice}. Reason: ${reason || "Could not be matched."} Please resubmit from your dashboard.`;
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
      from: EMAIL_SENDERS.sales,
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

router.get("/summary", employeeOrAdmin, asyncHandler(async (req, res, next) => {
  if (req.user.role === "admin") return next();
  const bookings = await Booking.find({ status: "ongoing" }).populate("user", "name email company phone").sort({ createdAt: -1 }).limit(ADMIN_LIST_LIMIT).lean();
  res.json({ ok: true, users: [], bookings, bills: [], payments: [], tickets: [], archivedTickets: [], employeeOnly: true });
}));

router.get("/orders", employeeOrAdmin, asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
  const search = cleanString(req.query.search);
  const filter = req.user.role === "employee" ? { status: "ongoing" } : {};
  if (search) {
    filter.$or = [
      { companyName: new RegExp(search, "i") },
      { email: new RegExp(search, "i") },
      { phone: new RegExp(search, "i") },
      { packageName: new RegExp(search, "i") },
    ];
  }
  const [orders, total] = await Promise.all([
    Booking.find(filter).populate("user", "name email company phone").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Booking.countDocuments(filter),
  ]);
  res.json({ ok: true, orders, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
}));

router.get("/orders/:id", employeeOrAdmin, asyncHandler(async (req, res) => {
  const filter = req.user.role === "employee" ? { _id: req.params.id, status: "ongoing" } : { _id: req.params.id };
  const order = await Booking.findOne(filter).populate("user", "name email company phone");
  if (!order) {
    const error = new Error("Order not found");
    error.statusCode = 404;
    throw error;
  }
  const summary = await buildOrderSummary(order);
  const safeSummary = req.user.role === "employee" ? staffSummary(summary) : summary;
  res.json({ ok: true, order, progress: safeSummary.timeline, invoices: req.user.role === "employee" ? [] : summary.billing.invoices, summary: safeSummary });
}));

router.post("/orders/:id/progress", employeeOrAdmin, asyncHandler(async (req, res) => {
  const filter = req.user.role === "employee" ? { _id: req.params.id, status: "ongoing" } : { _id: req.params.id };
  const order = await Booking.findOne(filter).populate("user", "name email company phone");
  if (!order) {
    const error = new Error("Order not found");
    error.statusCode = 404;
    throw error;
  }
  const progressPercent = Math.max(0, Math.min(100, Number(req.body.progressPercent) || 0));
  const title = cleanString(req.body.title || "Customer progress update");
  const description = cleanString(req.body.description);
  const customerName = cleanString(req.body.customerName);
  const customerEmail = cleanString(req.body.customerEmail);
  const customerPhone = cleanString(req.body.customerPhone);
  const customerAddress = cleanString(req.body.customerAddress);
  const status = EMPLOYEE_PROGRESS_STATUSES.includes(req.body.status) ? req.body.status : "completed";
  const callLog = status === "inquiry" ? cleanString(req.body.callLog) : "";
  if (!title || !customerName || !description) {
    const error = new Error("Title, customer name, and description are required");
    error.statusCode = 400;
    throw error;
  }
  const normalizedCustomerEmail = customerEmail ? validateEmail(customerEmail, "Enter a valid customer email") : "";
  const progress = await OrderProgress.create({
    order: order._id,
    title,
    description,
    customerName,
    customerEmail: normalizedCustomerEmail,
    customerPhone,
    customerAddress,
    happenedAt: parseDate(req.body.happenedAt) || new Date(),
    adminName: cleanString(req.body.adminName || req.user.name),
    admin: req.user._id,
    attachments: Array.isArray(req.body.attachments) ? req.body.attachments : [],
    progressPercent,
    status,
    callLog,
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
  const safeSummary = req.user.role === "employee" ? staffSummary(summary) : summary;
  res.status(201).json({ ok: true, order, progress, timeline: safeSummary.timeline, summary: safeSummary });
}));

router.use(requireAdmin);

router.get("/users", asyncHandler(async (_req, res) => {
  const users = await User.find().select("-passwordHash").sort({ createdAt: -1 }).limit(ADMIN_LIST_LIMIT).lean();
  res.json({ ok: true, users });
}));

router.post("/users/employee", asyncHandler(async (req, res) => {
  const name = cleanString(req.body.name);
  const emailInput = cleanString(req.body.email);
  const temporaryPassword = cleanString(req.body.temporaryPassword);
  if (!name || !emailInput || !temporaryPassword) {
    const error = new Error("Name, email, and temporary password are required");
    error.statusCode = 400;
    throw error;
  }
  const email = validateEmail(emailInput);
  if (temporaryPassword.length < 8) {
    const error = new Error("Temporary password must be at least 8 characters");
    error.statusCode = 400;
    throw error;
  }
  const exists = await User.findOne({ email });
  if (exists) {
    const error = new Error("Email is already registered");
    error.statusCode = 409;
    throw error;
  }

  const passwordHash = await bcrypt.hash(temporaryPassword, 10);
  const user = await User.create({
    name,
    email,
    passwordHash,
    role: "employee",
    status: "active",
    isEmailVerified: false,
    mustChangePassword: true,
  });
  const code = crypto.randomInt(100000, 999999).toString();
  const codeHash = await bcrypt.hash(code, 8);
  await Otp.create({
    email,
    codeHash,
    purpose: "signup",
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    resendAvailableAt: new Date(Date.now() + 60 * 1000),
  });
  await sendEmail({
    to: email,
    from: EMAIL_SENDERS.notifications,
    subject: "Your ZMH employee account",
    text: `Hi ${name},\n\nYour ZMH employee account has been created.\n\nLogin email: ${email}\nTemporary password: ${temporaryPassword}\nVerification code: ${code}\n\nAfter login, enter the code and set your own password.`,
    html: `<p>Hi ${escapeHtml(name)},</p><p>Your ZMH employee account has been created.</p><ul><li><strong>Login email:</strong> ${escapeHtml(email)}</li><li><strong>Temporary password:</strong> ${escapeHtml(temporaryPassword)}</li><li><strong>Verification code:</strong> ${escapeHtml(code)}</li></ul><p>After login, enter the code and set your own password.</p>`,
  }).catch((error) => {
    console.error("[employee invite email failed]", error.message);
  });

  const saved = await User.findById(user._id).select("-passwordHash");
  res.status(201).json({ ok: true, user: saved, message: "Employee created. Temporary password and OTP were emailed." });
}));

router.get("/approvals", asyncHandler(async (_req, res) => {
  const users = await User.find({ status: "pending" }).select("-passwordHash").sort({ createdAt: -1 }).limit(ADMIN_LIST_LIMIT).lean();
  res.json({ ok: true, users });
}));

router.get("/summary", asyncHandler(async (_req, res) => {
  const [users, bookings, bills, payments, tickets, archivedTickets] = await Promise.all([
    User.find().select("-passwordHash").sort({ createdAt: -1 }).limit(ADMIN_LIST_LIMIT).lean(),
    Booking.find().populate("user", "name email company").sort({ createdAt: -1 }).limit(ADMIN_LIST_LIMIT).lean(),
    Invoice.find().populate("user", "name email company").sort({ createdAt: -1 }).limit(ADMIN_LIST_LIMIT).lean(),
    PaymentSubmission.find()
      .populate("user", "name email company phone")
      .populate("order", "companyName packageName packagePrice nextBillingDate paymentStatus")
      .populate("invoice")
      .sort({ createdAt: -1 })
      .limit(ADMIN_LIST_LIMIT)
      .lean(),
    SupportTicket.find({ status: { $ne: "resolved" } }).populate("user", "name email company phone").populate("replies.admin", "name email").sort({ createdAt: -1 }).limit(ADMIN_LIST_LIMIT).lean(),
    SupportTicket.find({ status: "resolved" }).populate("user", "name email company phone").populate("replies.admin", "name email").sort({ createdAt: -1 }).limit(ADMIN_LIST_LIMIT).lean(),
  ]);
  res.json({ ok: true, users, bookings, bills, payments, tickets, archivedTickets });
}));

async function sendApprovalEmail(user) {
  try {
    await sendEmail({
      to: user.email,
      from: EMAIL_SENDERS.accounts,
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
  const bookings = await Booking.find().populate("user", "name email company").sort({ createdAt: -1 }).limit(ADMIN_LIST_LIMIT).lean();
  res.json({ ok: true, bookings });
}));

router.patch("/bookings/:id", asyncHandler(async (req, res) => {
  const allowed = ["status", "notes", "services", "operatingDays", "hours", "afterHours", "crm", "integrationNotes", "requestedDate", "adminResponse", "activeServices", "serviceUpdates", "contactPerson", "packageName", "packagePrice", "assignedStaff", "serviceStartDate", "nextBillingDate", "progressPercent", "paymentStatus", "filesUploaded"];
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
    Booking.find(filter).populate("user", "name email company phone").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
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
    status: ["inquiry", "planned", "in progress", "completed", "blocked"].includes(req.body.status) ? req.body.status : "completed",
    callLog: req.body.status === "inquiry" ? cleanString(req.body.callLog) : "",
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
  const pdf = createExecutiveSummaryPdfBuffer(order, summary);
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
  let summary = await buildOrderSummary(order);
  const invoice = await ensureOrderInvoice(order, summary);
  summary = await buildOrderSummary(order);
  const pdf = createExecutiveSummaryPdfBuffer(order, summary);
  const email = buildExecutiveSummaryEmail(order, summary);
  const history = new EmailHistory({
    order: order._id,
    invoice: invoice._id,
    to,
    from: EMAIL_ADDRESSES.billing,
    subject: email.subject,
  });
  try {
    const result = await sendEmail({
      to,
      from: EMAIL_SENDERS.billing,
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
  const settings = await Setting.find().sort({ key: 1 }).lean();
  res.json({ ok: true, settings });
}));

router.get("/bills", asyncHandler(async (_req, res) => {
  const bills = await Invoice.find().populate("user", "name email company").sort({ createdAt: -1 }).limit(ADMIN_LIST_LIMIT).lean();
  res.json({ ok: true, bills });
}));

async function emailBill(user, invoice) {
  if (!user?.email) return false;
  try {
    await sendEmail({
      to: user.email,
      from: EMAIL_SENDERS.billing,
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

router.get("/payments", asyncHandler(async (_req, res) => {
  const payments = await PaymentSubmission.find()
    .populate("user", "name email company phone")
    .populate("order", "companyName packageName packagePrice nextBillingDate paymentStatus")
    .populate("invoice")
    .sort({ createdAt: -1 })
    .limit(ADMIN_LIST_LIMIT)
    .lean();
  res.json({ ok: true, payments });
}));

router.post("/payments/:id/approve", asyncHandler(async (req, res) => {
  const payment = await PaymentSubmission.findById(req.params.id).populate("user", "name email company").populate("order").populate("invoice");
  if (!payment) {
    const error = new Error("Payment submission not found");
    error.statusCode = 404;
    throw error;
  }
  if (payment.status !== "submitted") {
    const error = new Error("This payment has already been reviewed.");
    error.statusCode = 409;
    throw error;
  }
  payment.status = "approved";
  payment.reviewedBy = req.user._id;
  payment.reviewedAt = new Date();
  payment.reviewReason = cleanString(req.body?.note || "Verified by admin");
  await payment.save();
  await ApprovalLog.create({
    admin: req.user._id,
    payment: payment._id,
    invoice: payment.invoice._id,
    action: "approved",
    reason: payment.reviewReason,
  });

  const invoice = await Invoice.findByIdAndUpdate(payment.invoice._id, { status: "paid" }, { new: true });
  let order = payment.order;
  if (order?._id) {
    order.paymentStatus = "paid";
    await order.save();
  } else {
    order = await Booking.findOneAndUpdate({ user: payment.user._id, companyName: payment.invoice.company }, { paymentStatus: "paid" }, { new: true });
  }
  await Notification.create({
    user: payment.user._id,
    title: "Payment approved",
    body: `Your payment for ${payment.invoice.invoice} has been verified. Thank you.`,
    type: "billing",
  });

  const refreshed = await PaymentSubmission.findById(payment._id).populate("user", "name email company").populate("order").populate("invoice");
  const email = {
    subject: "Payment Confirmation Approved",
    text: `Hello ${refreshed.user.name},\n\nYour payment for Invoice #${refreshed.invoice.invoice} has been successfully verified and approved.\n\nThank you for your payment.\n\nRegards,\nSupport Team`,
    html: `<p>Hello ${escapeHtml(refreshed.user.name)},</p><p>Your payment for Invoice #${escapeHtml(refreshed.invoice.invoice)} has been successfully verified and approved.</p><p>Thank you for your payment.</p><p>Regards,<br />Support Team</p>`,
  };
  let emailSent = false;
  try {
    const pdf = paymentPdfBuffer(invoice, refreshed, refreshed.user);
    const result = await sendEmail({
      to: refreshed.user.email,
      from: EMAIL_SENDERS.billing,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: [{ filename: `${invoice.invoice}-paid.pdf`, content: pdf.toString("base64"), contentType: "application/pdf" }],
    });
    emailSent = !result?.skipped;
  } catch (error) {
    console.error("[payment approval email failed]", error.message);
  }
  res.json({ ok: true, payment: refreshed, invoice, order, emailSent });
}));

router.post("/payments/:id/reject", asyncHandler(async (req, res) => {
  const payment = await PaymentSubmission.findById(req.params.id).populate("user", "name email company").populate("order").populate("invoice");
  if (!payment) {
    const error = new Error("Payment submission not found");
    error.statusCode = 404;
    throw error;
  }
  if (payment.status !== "submitted") {
    const error = new Error("This payment has already been reviewed.");
    error.statusCode = 409;
    throw error;
  }
  const reason = cleanString(req.body?.reason, "Payment could not be verified against the bank transfer record.");
  payment.status = "rejected";
  payment.reviewedBy = req.user._id;
  payment.reviewedAt = new Date();
  payment.reviewReason = reason;
  await payment.save();
  await ApprovalLog.create({
    admin: req.user._id,
    payment: payment._id,
    invoice: payment.invoice._id,
    action: "rejected",
    reason,
  });
  let order = payment.order;
  if (order?._id) {
    order.paymentStatus = "payment rejected";
    await order.save();
  }
  await Notification.create({
    user: payment.user._id,
    title: "Payment rejected",
    body: `Your payment for ${payment.invoice.invoice} could not be verified. Please resubmit with the correct details.`,
    type: "billing",
  });

  const refreshed = await PaymentSubmission.findById(payment._id).populate("user", "name email company").populate("order").populate("invoice");
  const email = paymentRejectedEmail(refreshed, reason);
  let emailSent = false;
  try {
    const result = await sendEmail({
      to: refreshed.user.email,
      from: EMAIL_SENDERS.billing,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    emailSent = !result?.skipped;
  } catch (error) {
    console.error("[payment rejection email failed]", error.message);
  }
  res.json({ ok: true, payment: refreshed, order, emailSent });
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
  const packages = await PackagePricing.find().sort({ displayOrder: 1, createdAt: 1 }).lean();
  if (packages.length) return res.json({ ok: true, packages: packages.map(publicPackage) });
  const setting = await Setting.findOne({ key: "packages" }).lean();
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

router.get("/support-tickets", asyncHandler(async (req, res) => {
  const filter = req.query.archived === "true" ? { status: "resolved" } : { status: { $ne: "resolved" } };
  await SupportTicket.updateMany({ status: "in review" }, { status: "in progress" });
  const tickets = await SupportTicket.find(filter).populate("user", "name email company phone").populate("replies.admin", "name email").sort({ createdAt: -1 }).limit(ADMIN_LIST_LIMIT).lean();
  res.json({ ok: true, tickets });
}));

router.patch("/support-tickets/:id", asyncHandler(async (req, res) => {
  const update = {};
  const requestedStatus = req.body.status === "in review" ? "in progress" : req.body.status;
  if (Object.prototype.hasOwnProperty.call(req.body, "status") && ["open", "in progress", "resolved"].includes(requestedStatus)) update.status = requestedStatus;
  const adminResponse = cleanString(req.body.adminResponse);
  if (Object.prototype.hasOwnProperty.call(req.body, "adminResponse")) update.adminResponse = adminResponse;
  if (update.status === "resolved") {
    update.resolvedAt = new Date();
    update.resolvedBy = req.user._id;
  }

  const updateOperation = { $set: update };
  if (adminResponse) {
    updateOperation.$push = { replies: { message: adminResponse, admin: req.user._id, adminName: req.user.name } };
  }
  const ticket = await SupportTicket.findByIdAndUpdate(req.params.id, updateOperation, { new: true }).populate("user", "name email company phone").populate("replies.admin", "name email");
  if (!ticket) {
    const error = new Error("Support ticket not found");
    error.statusCode = 404;
    throw error;
  }

  await Notification.create({
    user: ticket.user._id,
    title: update.status === "resolved" ? "Support ticket resolved" : "Support ticket replied to",
    body: adminResponse || `Your ticket status is now ${ticket.status}.`,
    type: "support",
  });
  if (ticket.user?.email) {
    try {
      await sendEmail({
        to: ticket.user.email,
        from: EMAIL_SENDERS.support,
        subject: update.status === "resolved" ? `Support ticket resolved: ${ticket.subject}` : `Support ticket update: ${ticket.subject}`,
        text: `Hello ${ticket.user.name || "there"},\n\n${adminResponse || `Your support ticket status is now ${ticket.status}.`}\n\nTicket: ${ticket.subject}\nStatus: ${ticket.status}\n\nRegards,\nSupport Team`,
        html: `
          <p>Hello ${escapeHtml(ticket.user.name || "there")},</p>
          <p>${escapeHtml(adminResponse || `Your support ticket status is now ${ticket.status}.`)}</p>
          <ul>
            <li><strong>Ticket:</strong> ${escapeHtml(ticket.subject)}</li>
            <li><strong>Status:</strong> ${escapeHtml(ticket.status)}</li>
          </ul>
          <p>Regards,<br />Support Team</p>
        `,
      });
    } catch (error) {
      console.error("[support ticket update email failed]", error.message);
    }
  }

  res.json({ ok: true, ticket });
}));

module.exports = router;
