const mongoose = require("mongoose");
const { EMAIL_ADDRESSES } = require("../config/emailConfig");

const userSchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true },
  email: { type: String, trim: true, lowercase: true, unique: true, required: true },
  passwordHash: { type: String, required: true },
  username: { type: String, trim: true, default: "" },
  company: { type: String, trim: true, default: "" },
  phone: { type: String, trim: true, default: "" },
  profilePicture: { type: String, trim: true, default: "" },
  role: { type: String, enum: ["user", "client", "agent", "admin"], default: "user" },
  status: { type: String, enum: ["active", "pending", "suspended"], default: "pending" },
  isEmailVerified: { type: Boolean, default: false },
}, { timestamps: true });

const otpSchema = new mongoose.Schema({
  email: { type: String, trim: true, lowercase: true, required: true, index: true },
  codeHash: { type: String, required: true },
  purpose: { type: String, enum: ["signup", "login", "reset"], default: "signup" },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  usedAt: { type: Date, default: null },
  resendAvailableAt: { type: Date, required: true },
}, { timestamps: true });

const bookingSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  companyName: { type: String, trim: true, required: true },
  email: { type: String, trim: true, lowercase: true, default: "" },
  businessType: { type: String, trim: true, default: "" },
  employees: { type: String, trim: true, default: "" },
  website: { type: String, trim: true, default: "" },
  phone: { type: String, trim: true, default: "" },
  address: { type: String, trim: true, default: "" },
  services: [{ type: String, trim: true }],
  hours: { type: String, trim: true, default: "" },
  afterHours: { type: String, trim: true, default: "" },
  crm: { type: String, trim: true, default: "" },
  integrationNotes: { type: String, trim: true, default: "" },
  requestedDate: { type: Date, default: null },
  status: { type: String, enum: ["new", "needs discussion", "ongoing", "cancelled"], default: "new" },
  notes: { type: String, trim: true, default: "" },
  adminResponse: { type: String, trim: true, default: "" },
  respondedAt: { type: Date, default: null },
  respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  activeServices: [{ type: String, trim: true }],
  serviceUpdates: { type: String, trim: true, default: "" },
  contactPerson: { type: String, trim: true, default: "" },
  packageName: { type: String, trim: true, default: "" },
  packagePrice: { type: String, trim: true, default: "" },
  assignedStaff: { type: String, trim: true, default: "" },
  serviceStartDate: { type: Date, default: null },
  nextBillingDate: { type: Date, default: null },
  progressPercent: { type: Number, min: 0, max: 100, default: 0 },
  paymentStatus: { type: String, enum: ["pending", "sent", "payment submitted", "payment rejected", "paid", "overdue", "waived"], default: "pending" },
  filesUploaded: [{
    name: { type: String, trim: true },
    url: { type: String, trim: true },
    uploadedAt: { type: Date, default: Date.now },
  }],
}, { timestamps: true });

bookingSchema.index({ status: 1, createdAt: -1 });
bookingSchema.index({ user: 1, status: 1 });

const contactSchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true },
  company: { type: String, trim: true, default: "" },
  email: { type: String, trim: true, lowercase: true, required: true },
  phone: { type: String, trim: true, default: "" },
  message: { type: String, trim: true, required: true },
  status: { type: String, enum: ["new", "contacted", "closed"], default: "new" },
}, { timestamps: true });

const invoiceSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  invoice: { type: String, trim: true, required: true, unique: true },
  company: { type: String, trim: true, required: true },
  amount: { type: Number, default: 0 },
  currency: { type: String, default: "USD" },
  status: { type: String, enum: ["draft", "sent", "paid", "overdue", "void"], default: "draft" },
  dueDate: { type: Date, default: null },
  lineItems: [{ label: String, amount: Number }],
  message: { type: String, trim: true, default: "" },
}, { timestamps: true });

invoiceSchema.index({ user: 1, createdAt: -1 });
invoiceSchema.index({ company: 1, createdAt: -1 });

const orderProgressSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", required: true, index: true },
  title: { type: String, trim: true, required: true },
  description: { type: String, trim: true, default: "" },
  status: { type: String, enum: ["planned", "in progress", "completed", "blocked"], default: "completed" },
  progressPercent: { type: Number, min: 0, max: 100, default: 0 },
  adminName: { type: String, trim: true, default: "" },
  admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  attachments: [{
    name: { type: String, trim: true },
    url: { type: String, trim: true },
  }],
  happenedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

orderProgressSchema.index({ order: 1, happenedAt: -1 });

const packagePricingSchema = new mongoose.Schema({
  slug: { type: String, trim: true, lowercase: true, required: true, unique: true },
  name: { type: String, trim: true, required: true },
  description: { type: String, trim: true, default: "" },
  bestFor: { type: String, trim: true, default: "" },
  price: { type: String, trim: true, default: "Custom" },
  displayOrder: { type: Number, default: 0, index: true },
  highlightBadge: { type: String, trim: true, default: "" },
  buttonText: { type: String, trim: true, default: "Package details" },
  buttonLink: { type: String, trim: true, default: "" },
  status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
  recommended: { type: Boolean, default: false },
  features: [{
    text: { type: String, trim: true, required: true },
    order: { type: Number, default: 0 },
  }],
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });

packagePricingSchema.index({ status: 1, displayOrder: 1 });

const emailHistorySchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null, index: true },
  invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null },
  to: { type: String, trim: true, lowercase: true, required: true },
  from: { type: String, trim: true, default: EMAIL_ADDRESSES.sales },
  subject: { type: String, trim: true, required: true },
  status: { type: String, enum: ["sent", "skipped", "failed"], default: "sent" },
  providerId: { type: String, trim: true, default: "" },
  error: { type: String, trim: true, default: "" },
}, { timestamps: true });

const paymentSubmissionSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  order: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null, index: true },
  invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
  amount: { type: Number, default: 0 },
  currency: { type: String, default: "USD" },
  paymentDate: { type: Date, required: true },
  paymentMethod: { type: String, trim: true, required: true },
  transactionId: { type: String, trim: true, required: true },
  note: { type: String, trim: true, default: "" },
  screenshot: {
    name: { type: String, trim: true, default: "" },
    dataUrl: { type: String, trim: true, default: "" },
  },
  status: { type: String, enum: ["submitted", "approved", "rejected"], default: "submitted", index: true },
  reviewReason: { type: String, trim: true, default: "" },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  reviewedAt: { type: Date, default: null },
}, { timestamps: true });

paymentSubmissionSchema.index({ invoice: 1, status: 1 });
paymentSubmissionSchema.index({ user: 1, invoice: 1, status: 1 });

const supportTicketSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  subject: { type: String, trim: true, required: true },
  message: { type: String, trim: true, required: true },
  status: { type: String, enum: ["open", "in progress", "resolved"], default: "open", index: true },
  adminResponse: { type: String, trim: true, default: "" },
  replies: [{
    message: { type: String, trim: true, required: true },
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    adminName: { type: String, trim: true, default: "" },
    createdAt: { type: Date, default: Date.now },
  }],
  resolvedAt: { type: Date, default: null },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });

supportTicketSchema.index({ user: 1, createdAt: -1 });

const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  title: { type: String, trim: true, required: true },
  body: { type: String, trim: true, default: "" },
  type: { type: String, default: "info" },
  readAt: { type: Date, default: null },
}, { timestamps: true });

notificationSchema.index({ user: 1, readAt: 1, createdAt: -1 });

const settingSchema = new mongoose.Schema({
  key: { type: String, trim: true, unique: true, required: true },
  value: { type: mongoose.Schema.Types.Mixed, default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });

const approvalLogSchema = new mongoose.Schema({
  admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  payment: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentSubmission", default: null, index: true },
  invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", default: null },
  action: { type: String, enum: ["approved", "rejected"], required: true },
  reason: { type: String, trim: true, default: "" },
}, { timestamps: true });

module.exports = {
  User: mongoose.model("User", userSchema),
  Otp: mongoose.model("Otp", otpSchema),
  Booking: mongoose.model("Booking", bookingSchema),
  Contact: mongoose.model("Contact", contactSchema),
  Invoice: mongoose.model("Invoice", invoiceSchema),
  SupportTicket: mongoose.model("SupportTicket", supportTicketSchema),
  Notification: mongoose.model("Notification", notificationSchema),
  OrderProgress: mongoose.model("OrderProgress", orderProgressSchema),
  PackagePricing: mongoose.model("PackagePricing", packagePricingSchema),
  EmailHistory: mongoose.model("EmailHistory", emailHistorySchema),
  PaymentSubmission: mongoose.model("PaymentSubmission", paymentSubmissionSchema),
  ApprovalLog: mongoose.model("ApprovalLog", approvalLogSchema),
  Setting: mongoose.model("Setting", settingSchema),
};
