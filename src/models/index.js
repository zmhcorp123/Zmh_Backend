const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true },
  email: { type: String, trim: true, lowercase: true, unique: true, required: true },
  passwordHash: { type: String, required: true },
  company: { type: String, trim: true, default: "" },
  phone: { type: String, trim: true, default: "" },
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
  status: { type: String, enum: ["new", "needs review", "confirmed", "completed", "cancelled"], default: "new" },
  notes: { type: String, trim: true, default: "" },
}, { timestamps: true });

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
}, { timestamps: true });

const notificationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  title: { type: String, trim: true, required: true },
  body: { type: String, trim: true, default: "" },
  type: { type: String, default: "info" },
  readAt: { type: Date, default: null },
}, { timestamps: true });

const settingSchema = new mongoose.Schema({
  key: { type: String, trim: true, unique: true, required: true },
  value: { type: mongoose.Schema.Types.Mixed, default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });

module.exports = {
  User: mongoose.model("User", userSchema),
  Otp: mongoose.model("Otp", otpSchema),
  Booking: mongoose.model("Booking", bookingSchema),
  Contact: mongoose.model("Contact", contactSchema),
  Invoice: mongoose.model("Invoice", invoiceSchema),
  Notification: mongoose.model("Notification", notificationSchema),
  Setting: mongoose.model("Setting", settingSchema),
};
