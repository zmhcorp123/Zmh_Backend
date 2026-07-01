require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { connectDb } = require("./src/config/db");
const { errorHandler, notFound } = require("./src/middleware/error");
const authRoutes = require("./src/routes/auth.routes");
const bookingRoutes = require("./src/routes/booking.routes");
const contactRoutes = require("./src/routes/contact.routes");
const dashboardRoutes = require("./src/routes/dashboard.routes");
const adminRoutes = require("./src/routes/admin.routes");
const chatbotRoutes = require("./src/routes/chatbot.routes");

const app = express();
const port = process.env.PORT || 5000;

const defaultOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://zmhusacorp.com",
  "https://www.zmhusacorp.com",
];

const configuredOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = [...new Set([...defaultOrigins, ...configuredOrigins])];

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS"));
  },
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => {
  res.json({ ok: true, name: "ZMH Backend API", version: "1.0.0" });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    database: global.mongooseReadyState || "unknown",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api", dashboardRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/chatbot", chatbotRoutes);
app.use(notFound);
app.use(errorHandler);

connectDb().then(() => {
  app.listen(port, () => {
    console.log(`ZMH backend running on port ${port}`);
  });
});
