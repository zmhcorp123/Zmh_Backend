const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { User, Otp } = require("../models");
const { sendEmail } = require("../config/email");
const { EMAIL_ADDRESSES, EMAIL_SENDERS } = require("../config/emailConfig");
const { asyncHandler } = require("../utils/asyncHandler");
const { publicUser } = require("../utils/publicUser");
const { signToken } = require("../middleware/auth");

const router = express.Router();

function required(value, message) {
  if (!value) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }
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
  const codeHash = await bcrypt.hash(code, 10);
  const timing = otpTiming();
  await Otp.create({ email, codeHash, purpose, ...timing });
  await sendEmail({
    to: email,
    from: EMAIL_SENDERS.notifications,
    subject: "Your ZMH verification code",
    text: `Your ZMH verification code is ${code}. It expires in ${timing.expiryMinutes} minutes.`,
    html: `<p>Your ZMH verification code is <strong>${code}</strong>.</p><p>It expires in ${timing.expiryMinutes} minutes.</p>`,
  });
}

async function notifyAccountsOfSignup(user) {
  try {
    await sendEmail({
      to: process.env.ACCOUNTS_EMAIL || EMAIL_ADDRESSES.accounts,
      from: EMAIL_SENDERS.accounts,
      subject: `New signup request: ${user.name}`,
      text: `A new user requested signup.\n\nName: ${user.name}\nEmail: ${user.email}\nCompany: ${user.company || "Not provided"}\nPhone: ${user.phone || "Not provided"}\nStatus: ${user.status}`,
      html: `
        <p>A new user requested signup.</p>
        <ul>
          <li><strong>Name:</strong> ${user.name}</li>
          <li><strong>Email:</strong> ${user.email}</li>
          <li><strong>Company:</strong> ${user.company || "Not provided"}</li>
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
  const { name, email, password, company, phone } = req.body;
  required(name, "Name is required");
  required(email, "Email is required");
  required(password, "Password is required");

  const exists = await User.findOne({ email: email.toLowerCase() });
  if (exists) {
    const error = new Error("Email is already registered");
    error.statusCode = 409;
    throw error;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({ name, email, passwordHash, company, phone, status: "pending", isEmailVerified: false });
  await createAndSendOtp(user.email, "signup");
  await notifyAccountsOfSignup(user);
  res.status(201).json({
    ok: true,
    user: publicUser(user),
    requiresOtp: true,
    requiresApproval: true,
    message: "Account created. Check your email for the OTP. Admin approval is required before login.",
  });
}));

router.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  required(email, "Email is required");
  required(password, "Password is required");

  const user = await User.findOne({ email: email.toLowerCase() });
  const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;
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
  if (!user.isEmailVerified) {
    const error = new Error("Please verify your email OTP before logging in");
    error.statusCode = 403;
    throw error;
  }
  if (user.status !== "active") {
    const error = new Error("Your account is pending admin approval");
    error.statusCode = 403;
    throw error;
  }
  res.json({ ok: true, user: publicUser(user), token: signToken(user) });
}));

router.post("/otp/send", asyncHandler(async (req, res) => {
  const { email, purpose = "signup" } = req.body;
  required(email, "Email is required");
  await createAndSendOtp(email.toLowerCase(), purpose);
  res.json({ ok: true, message: "OTP sent." });
}));

router.post("/otp/resend", asyncHandler(async (req, res) => {
  const { email, purpose = "signup" } = req.body;
  required(email, "Email is required");

  const latest = await Otp.findOne({ email: email.toLowerCase(), purpose }).sort({ createdAt: -1 });
  if (latest && latest.resendAvailableAt > new Date()) {
    const error = new Error("Please wait before requesting another OTP");
    error.statusCode = 429;
    throw error;
  }

  await createAndSendOtp(email.toLowerCase(), purpose);
  res.json({ ok: true, message: "OTP resent." });
}));

router.post("/otp/verify", asyncHandler(async (req, res) => {
  const { email, otp, purpose = "signup" } = req.body;
  required(email, "Email is required");
  required(otp, "OTP code is required");

  const record = await Otp.findOne({
    email: email.toLowerCase(),
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
    { email: email.toLowerCase() },
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
  const user = await User.findOne({ email: email.toLowerCase() });
  if (user) await createAndSendOtp(user.email, "reset");
  res.json({ ok: true, message: "If that email exists, password reset instructions were sent." });
}));

router.post("/reset-password", asyncHandler(async (req, res) => {
  const { email, otp, password } = req.body;
  required(email, "Email is required");
  required(otp, "OTP code is required");
  required(password, "New password is required");

  const record = await Otp.findOne({
    email: email.toLowerCase(),
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

  const passwordHash = await bcrypt.hash(password, 12);
  await User.findOneAndUpdate({ email: email.toLowerCase() }, { passwordHash });
  record.usedAt = new Date();
  await record.save();
  res.json({ ok: true, message: "Password updated." });
}));

module.exports = router;
