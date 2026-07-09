process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-with-enough-length";

const assert = require("node:assert/strict");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { validateEmail, isValidEmail } = require("../src/utils/validateEmail");
const authRoutes = require("../src/routes/auth.routes");

test("validateEmail normalizes valid email addresses", () => {
  assert.equal(validateEmail("  USER@Example.COM  "), "user@example.com");
  assert.equal(isValidEmail("person+tag@example.co"), true);
});

test("validateEmail rejects invalid email before callers query the database", () => {
  assert.throws(() => validateEmail("not-an-email"), /valid email/);
  assert.throws(() => validateEmail("missing-domain@"), /valid email/);
});

test("JWT_SECRET is required at startup", () => {
  const result = spawnSync(process.execPath, ["-e", "delete process.env.JWT_SECRET; require('./src/config/env')"], {
    cwd: process.cwd(),
    env: { ...process.env, JWT_SECRET: "" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /JWT_SECRET is required/);
});

test("concurrent OTP resend updates one record and rejects the racing request", async () => {
  const sent = [];
  const store = {
    record: {
      email: "client@example.com",
      purpose: "signup",
      codeHash: "old",
      resendAvailableAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 600000),
      createdAt: new Date(),
    },
    async findOneAndUpdate(query, update) {
      const matchesEmail = query.email === this.record.email && query.purpose === this.record.purpose;
      const available = this.record.resendAvailableAt <= query.$or[0].resendAvailableAt.$lte;
      if (!matchesEmail || !available) return null;
      this.record = { ...this.record, ...update };
      return this.record;
    },
    findOne(query) {
      return {
        sort: async () => (query.email === this.record.email && query.purpose === this.record.purpose ? this.record : null),
      };
    },
  };

  const deps = {
    Otp: store,
    bcrypt: { hash: async (value) => `hash:${value}` },
    crypto: { randomInt: () => 123456 + sent.length },
    sendEmail: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
    EMAIL_SENDERS: { notifications: "security@example.com" },
  };

  const results = await Promise.allSettled([
    authRoutes._test.resendOtp("client@example.com", "signup", deps),
    authRoutes._test.resendOtp("client@example.com", "signup", deps),
  ]);

  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected").length, 1);
  assert.equal(sent.length, 1);
});
