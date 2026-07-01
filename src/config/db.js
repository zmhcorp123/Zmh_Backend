const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { User } = require("../models");

async function seedAdmin() {
  const email = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;
  if (!email || !password) return;

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) return;

  const passwordHash = await bcrypt.hash(password, 12);
  await User.create({
    name: "ZMH Admin",
    email,
    passwordHash,
    role: "admin",
    status: "active",
    isEmailVerified: true,
    company: "ZMH Operations",
  });
  console.log(`Seeded admin user: ${email}`);
}

async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is required");
  }

  mongoose.connection.on("connected", () => {
    global.mongooseReadyState = "connected";
  });
  mongoose.connection.on("disconnected", () => {
    global.mongooseReadyState = "disconnected";
  });

  await mongoose.connect(uri);
  await seedAdmin();
  return mongoose.connection;
}

module.exports = { connectDb };
