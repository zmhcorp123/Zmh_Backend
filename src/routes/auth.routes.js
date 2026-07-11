const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { User, Otp } = require("../models");
const { sendEmail } = require("../config/email");
const { EMAIL_ADDRESSES, EMAIL_SENDERS } = require("../config/emailConfig");
const { asyncHandler } = require("../utils/asyncHandler");
const { publicUser } = require("../utils/publicUser");
const { requireAuth, signToken } = require("../middleware/auth");
const { validateEmail } = require("../utils/validateEmail");

const router = express.Router();
const PASSWORD_HASH_ROUNDS = Number(process.env.PASSWORD_HASH_ROUNDS || 10);
const OTP_HASH_ROUNDS = Number(process.env.OTP_HASH_ROUNDS || 8);
const LOGIN_USER_FIELDS = "name email passwordHash username company country countryCode phoneCode phone profilePicture role status isEmailVerified mustChangePassword";
const COUNTRIES = [
  { name: "United States", code: "US", dialCode: "+1" },
  { name: "Canada", code: "CA", dialCode: "+1" },
  { name: "United Kingdom", code: "GB", dialCode: "+44" },
  { name: "Australia", code: "AU", dialCode: "+61" },
  { name: "Bangladesh", code: "BD", dialCode: "+880" },
  { name: "India", code: "IN", dialCode: "+91" },
  { name: "Pakistan", code: "PK", dialCode: "+92" },
  { name: "United Arab Emirates", code: "AE", dialCode: "+971" },
];

function required(value, message) {
  if (!value) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }
}

function elapsedMs(start) {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e6);
}

function maskEmail(email = "") {
  const [name, domain] = String(email).split("@");
  if (!domain) return "unknown";
  return `${name.slice(0, 2)}***@${domain}`;
}

function logLoginStep(requestId, step, details = {}) {
  console.log("[auth:login]", { requestId, step, ...details });
}

function normalizeSignupContact(body) {
  const countryCode = String(body.countryCode || "").trim().toUpperCase();
  const country = COUNTRIES.find((item) => item.code === countryCode) || {
    name: String(body.country || "").trim(), code: countryCode, dialCode: String(body.phoneCode || "").trim(),
  };
  required(countryCode, "Country is required");
  if (!country.name || !/^\+[1-9]\d{0,3}$/.test(country.dialCode)) {
    const error = new Error("Select a valid country");
    error.statusCode = 400;
    throw error;
  }

  const phoneCode = String(body.phoneCode || country.dialCode).trim();
  const phone = String(body.phone || "").trim();
  required(phone, "Phone number is required");
  if (phoneCode !== country.dialCode || !phone.startsWith(country.dialCode)) {
    const error = new Error("Phone number must match the selected country code");
    error.statusCode = 400;
    throw error;
  }
  if (!/^\+\d{1,4}[\s().\-\d]{6,24}$/.test(phone)) {
    const error = new Error("Enter a valid phone number");
    error.statusCode = 400;
    throw error;
  }

  return {
    country: country.name,
    countryCode: country.code,
    phoneCode: country.dialCode,
    phone,
  };
}

function otpTiming() {
  const expiryMinutes = Number(process.env.OTP_EXPIRY_MINUTES || 10);
  const resendSeconds = Number(process.env.OTP_RESEND_SECONDS || 60);
  return {
    expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000),
    resendAvailableAt: new Date(Date.now() + resendSeconds * 1000),
    expiryMinutes,
  };
}

async function createAndSendOtp(email, purpose = "signup") {
  const code = crypto.randomInt(100000, 999999).toString();
  const codeHash = await bcrypt.hash(code, OTP_HASH_ROUNDS);
  const timing = otpTiming();
  await Otp.findOneAndUpdate(
    { email, purpose },
    { codeHash, purpose, usedAt: null, ...timing },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  sendEmail({
    to: email,
    from: EMAIL_SENDERS.notifications,
    subject: "Your ZMH verification code",
    text: `Your ZMH verification code is ${code}. It expires in ${timing.expiryMinutes} minutes.`,
    html: `<p>Your ZMH verification code is <strong>${code}</strong>.</p><p>It expires in ${timing.expiryMinutes} minutes.</p>`,
  }).catch((error) => {
    console.error("[otp email failed]", error.message);
  });
}

async function resendOtp(email, purpose = "signup", deps = {}) {
  const otpModel = deps.Otp || Otp;
  const bcryptLib = deps.bcrypt || bcrypt;
  const cryptoLib = deps.crypto || crypto;
  const sendEmailFn = deps.sendEmail || sendEmail;
  const emailSenders = deps.EMAIL_SENDERS || EMAIL_SENDERS;
  const code = cryptoLib.randomInt(100000, 999999).toString();
  const codeHash = await bcryptLib.hash(code, OTP_HASH_ROUNDS);
  const timing = otpTiming();
  const now = new Date();
  const record = await otpModel.findOneAndUpdate(
    {
      email,
      purpose,
      $or: [
        { resendAvailableAt: { $lte: now } },
        { resendAvailableAt: { $exists: false } },
      ],
    },
    { codeHash, purpose, usedAt: null, ...timing },
    { new: true, sort: { createdAt: -1 } }
  );

  if (!record) {
    const latest = await otpModel.findOne({ email, purpose }).sort({ createdAt: -1 });
    if (latest) {
      const error = new Error("Please wait before requesting another OTP");
      error.statusCode = 429;
      throw error;
    }
    await otpModel.findOneAndUpdate(
      { email, purpose },
      { codeHash, purpose, usedAt: null, ...timing },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  sendEmailFn({
    to: email,
    from: emailSenders.notifications,
    subject: "Your ZMH verification code",
    text: `Your ZMH verification code is ${code}. It expires in ${timing.expiryMinutes} minutes.`,
    html: `<p>Your ZMH verification code is <strong>${code}</strong>.</p><p>It expires in ${timing.expiryMinutes} minutes.</p>`,
  }).catch((error) => {
    console.error("[otp email failed]", error.message);
  });
}

async function notifyAccountsOfSignup(user) {
  try {
    await sendEmail({
      to: process.env.ACCOUNTS_EMAIL || EMAIL_ADDRESSES.accounts,
      from: EMAIL_SENDERS.accounts,
      subject: `New signup request: ${user.name}`,
      text: `A new user requested signup.\n\nName: ${user.name}\nEmail: ${user.email}\nCompany: ${user.company || "Not provided"}\nCountry: ${user.country || "Not provided"}\nPhone: ${user.phone || "Not provided"}\nStatus: ${user.status}`,
      html: `
        <p>A new user requested signup.</p>
        <ul>
          <li><strong>Name:</strong> ${user.name}</li>
          <li><strong>Email:</strong> ${user.email}</li>
          <li><strong>Company:</strong> ${user.company || "Not provided"}</li>
          <li><strong>Country:</strong> ${user.country || "Not provided"}</li>
          <li><strong>Phone:</strong> ${user.phone || "Not provided"}</li>
          <li><strong>Status:</strong> ${user.status}</li>
        </ul>
      `,
    });
  } catch (error) {
    console.error("[signup accounts email failed]", error.message);
  }
}

router.post("/signup", asyncHandler(async (req, res) => {
  const { name, email, password, company } = req.body;
  required(name, "Name is required");
  required(email, "Email is required");
  required(password, "Password is required");
  const normalizedEmail = validateEmail(email);
  const contact = normalizeSignupContact(req.body);

  const exists = await User.findOne({ email: normalizedEmail });
  if (exists) {
    const error = new Error("Email is already registered");
    error.statusCode = 409;
    throw error;
  }

  const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
  const user = await User.create({ name, email: normalizedEmail, passwordHash, company, ...contact, status: "pending", isEmailVerified: false });
  await createAndSendOtp(user.email, "signup");
  notifyAccountsOfSignup(user);
  res.status(201).json({
    ok: true,
    user: publicUser(user),
    requiresOtp: true,
    requiresApproval: true,
    message: "Account created. Check your email for the OTP. Admin approval is required before login.",
  });
}));

router.post("/login", asyncHandler(async (req, res) => {
  const requestStart = process.hrtime.bigint();
  const requestId = crypto.randomUUID();
  const timings = {};
  const { email, password } = req.body;
  required(email, "Email is required");
  required(password, "Password is required");
  const normalizedEmail = validateEmail(email);
  const safeEmail = maskEmail(normalizedEmail);

  logLoginStep(requestId, "request received", { email: safeEmail });
  res.once("finish", () => {
    logLoginStep(requestId, "response sent", {
      email: safeEmail,
      statusCode: res.statusCode,
      totalMs: elapsedMs(requestStart),
      ...timings,
    });
  });

  try {
    const queryStart = process.hrtime.bigint();
    const user = await User.findOne({ email: normalizedEmail }).select(LOGIN_USER_FIELDS).lean();
    timings.dbQueryMs = elapsedMs(queryStart);
    logLoginStep(requestId, "database query", { email: safeEmail, durationMs: timings.dbQueryMs, userFound: Boolean(user) });

    const passwordStart = process.hrtime.bigint();
    const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;
    timings.passwordVerifyMs = elapsedMs(passwordStart);
    logLoginStep(requestId, "password comparison", { email: safeEmail, durationMs: timings.passwordVerifyMs });
    if (!valid) {
      const error = new Error("Invalid email or password");
      error.statusCode = 401;
      throw error;
    }
    if (user.status === "suspended") {
      const error = new Error("Account is suspended");
      error.statusCode = 403;
      throw error;
    }
    const canCompleteEmployeeSetup = user.role === "employee" && user.mustChangePassword && user.status === "active";
    if (!user.isEmailVerified && !canCompleteEmployeeSetup) {
      const error = new Error("Please verify your email OTP before logging in");
      error.statusCode = 403;
      throw error;
    }
    if (user.status !== "active") {
      const error = new Error("Your account is pending admin approval");
      error.statusCode = 403;
      throw error;
    }

    const jwtStart = process.hrtime.bigint();
    const token = signToken(user);
    timings.jwtMs = elapsedMs(jwtStart);
    logLoginStep(requestId, "jwt generation", { email: safeEmail, durationMs: timings.jwtMs });
    res.json({
      ok: true,
      user: publicUser(user),
      token,
      requiresEmployeeSetup: canCompleteEmployeeSetup,
    });
  } catch (error) {
    logLoginStep(requestId, "failed", { email: safeEmail, status: error.statusCode || "error", totalMs: elapsedMs(requestStart), ...timings });
    throw error;
  }
}));

router.post("/employee/complete-setup", requireAuth, asyncHandler(async (req, res) => {
  const { otp, password } = req.body;
  required(otp, "OTP code is required");
  required(password, "New password is required");
  if (req.user.role !== "employee") {
    const error = new Error("Employee setup is only available for employee accounts");
    error.statusCode = 403;
    throw error;
  }
  if (String(password).length < 8) {
    const error = new Error("New password must be at least 8 characters");
    error.statusCode = 400;
    throw error;
  }

  const record = await Otp.findOne({
    email: req.user.email.toLowerCase(),
    purpose: "signup",
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });

  const valid = record ? await bcrypt.compare(String(otp), record.codeHash) : false;
  if (!valid) {
    const error = new Error("Invalid or expired OTP");
    error.statusCode = 400;
    throw error;
  }

  record.usedAt = new Date();
  await record.save();
  const user = await User.findById(req.user._id);
  user.passwordHash = await bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
  user.isEmailVerified = true;
  user.mustChangePassword = false;
  user.status = "active";
  await user.save();

  res.json({
    ok: true,
    user: publicUser(user),
    token: signToken(user),
    message: "Employee account setup completed.",
  });
}));

router.post("/otp/send", asyncHandler(async (req, res) => {
  const { email, purpose = "signup" } = req.body;
  required(email, "Email is required");
  const normalizedEmail = validateEmail(email);
  await createAndSendOtp(normalizedEmail, purpose);
  res.json({ ok: true, message: "OTP sent." });
}));

router.post("/otp/resend", asyncHandler(async (req, res) => {
  const { email, purpose = "signup" } = req.body;
  required(email, "Email is required");
  const normalizedEmail = validateEmail(email);
  await resendOtp(normalizedEmail, purpose);
  res.json({ ok: true, message: "OTP resent." });
}));

router.post("/otp/verify", asyncHandler(async (req, res) => {
  const { email, otp, purpose = "signup" } = req.body;
  required(email, "Email is required");
  required(otp, "OTP code is required");
  const normalizedEmail = validateEmail(email);

  const record = await Otp.findOne({
    email: normalizedEmail,
    purpose,
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });

  const valid = record ? await bcrypt.compare(otp, record.codeHash) : false;
  if (!valid) {
    const error = new Error("Invalid or expired OTP");
    error.statusCode = 400;
    throw error;
  }

  record.usedAt = new Date();
  await record.save();
  const user = await User.findOneAndUpdate(
    { email: normalizedEmail },
    { isEmailVerified: true },
    { new: true }
  );

  res.json({
    ok: true,
    user: user ? publicUser(user) : null,
    requiresApproval: user?.status !== "active",
    message: user?.status === "active" ? "Email verified. You can now log in." : "Email verified. Your account is waiting for admin approval.",
  });
}));

router.post("/forgot-password", asyncHandler(async (req, res) => {
  const { email } = req.body;
  required(email, "Email is required");
  const normalizedEmail = validateEmail(email);
  const user = await User.findOne({ email: normalizedEmail });
  if (user) await createAndSendOtp(user.email, "reset");
  res.json({ ok: true, message: "If that email exists, password reset instructions were sent." });
}));

router.post("/reset-password", asyncHandler(async (req, res) => {
  const { email, otp, password } = req.body;
  required(email, "Email is required");
  required(otp, "OTP code is required");
  required(password, "New password is required");
  const normalizedEmail = validateEmail(email);

  const record = await Otp.findOne({
    email: normalizedEmail,
    purpose: "reset",
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });

  const valid = record ? await bcrypt.compare(otp, record.codeHash) : false;
  if (!valid) {
    const error = new Error("Invalid or expired reset code");
    error.statusCode = 400;
    throw error;
  }

  const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
  await User.findOneAndUpdate({ email: normalizedEmail }, { passwordHash });
  record.usedAt = new Date();
  await record.save();
  res.json({ ok: true, message: "Password updated." });
}));

router._test = { createAndSendOtp, resendOtp };

module.exports = router;
