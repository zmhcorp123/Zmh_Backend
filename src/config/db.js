const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { User } = require("../models");

let connectionPromise = null;
let listenersRegistered = false;
let maintenanceStarted = false;

function elapsedMs(start) {
  return Math.round(Number(process.hrtime.bigint() - start) / 1e6);
}

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
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connectionPromise) return connectionPromise;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is required");
  }

  if (!listenersRegistered) {
    listenersRegistered = true;
    mongoose.connection.on("connected", () => {
      global.mongooseReadyState = "connected";
    });
    mongoose.connection.on("disconnected", () => {
      global.mongooseReadyState = "disconnected";
    });
  }

  const connectStart = process.hrtime.bigint();
  console.log("[startup:db] connecting to MongoDB");

  connectionPromise = mongoose.connect(uri, {
    maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 10),
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 10000),
    autoIndex: process.env.MONGODB_AUTO_INDEX === "true",
  }).then(async () => {
    console.log("[startup:db] MongoDB connected", { durationMs: elapsedMs(connectStart) });
    runPostConnectMaintenance();
    return mongoose.connection;
  }).catch((error) => {
    connectionPromise = null;
    console.error("[startup:db] connection failed", { durationMs: elapsedMs(connectStart), message: error.message });
    throw error;
  });

  return connectionPromise;
}

function runPostConnectMaintenance() {
  if (maintenanceStarted) return;
  maintenanceStarted = true;

  setImmediate(async () => {
    const maintenanceStart = process.hrtime.bigint();
    try {
      if (process.env.MONGODB_SYNC_INDEXES === "true") {
        const indexStart = process.hrtime.bigint();
        await User.syncIndexes();
        console.log("[startup:db] user indexes synced", { durationMs: elapsedMs(indexStart) });
      }

      await seedAdmin();
      console.log("[startup:db] maintenance complete", { durationMs: elapsedMs(maintenanceStart) });
    } catch (error) {
      console.error("[startup:db] maintenance failed", { durationMs: elapsedMs(maintenanceStart), message: error.message });
    }
  });
}

module.exports = { connectDb };
