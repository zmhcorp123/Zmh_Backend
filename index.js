require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");
const { connectDb } = require("./src/config/db");
const { errorHandler, notFound } = require("./src/middleware/error");
const authRoutes = require("./src/routes/auth.routes");
const bookingRoutes = require("./src/routes/booking.routes");
const contactRoutes = require("./src/routes/contact.routes");
const dashboardRoutes = require("./src/routes/dashboard.routes");
const adminRoutes = require("./src/routes/admin.routes");
const chatbotRoutes = require("./src/routes/chatbot.routes");
const settingsRoutes = require("./src/routes/settings.routes");

const app = express();
const port = process.env.PORT || 5000;
const frontendDistPath = process.env.FRONTEND_DIST_PATH || path.join(__dirname, "dist");
const frontendIndexPath = path.join(frontendDistPath, "index.html");
const apiRateWindowMs = Number(process.env.API_RATE_WINDOW_MS || 15 * 60 * 1000);
const apiRateLimit = Number(process.env.API_RATE_LIMIT || 900);
const rateBuckets = new Map();

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

app.disable("x-powered-by");
app.set("trust proxy", 1);

function apiRateLimiter(req, res, next) {
  if (req.method === "OPTIONS" || req.path === "/api/health") return next();
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + apiRateWindowMs };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + apiRateWindowMs;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  res.setHeader("RateLimit-Limit", String(apiRateLimit));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, apiRateLimit - bucket.count)));
  res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
  if (bucket.count > apiRateLimit) {
    return res.status(429).json({ ok: false, message: "Too many requests. Please try again soon." });
  }
  return next();
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets.entries()) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
}, Math.min(apiRateWindowMs, 60 * 1000)).unref?.();

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(compression({ threshold: 1024 }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin is not allowed by CORS"));
  },
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));
app.use("/api", apiRateLimiter);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

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
app.use("/api/settings", settingsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/chatbot", chatbotRoutes);

if (fs.existsSync(frontendIndexPath)) {
  app.use(express.static(frontendDistPath, {
    etag: true,
    lastModified: true,
    maxAge: "1h",
    setHeaders(res, filePath) {
      const normalizedPath = filePath.split(path.sep).join("/");
      if (normalizedPath.includes("/assets/") || normalizedPath.includes("/brand/")) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        return;
      }
      if (/\.(?:css|js|mjs|webp|avif|png|jpg|jpeg|svg|ico|woff2?)$/i.test(normalizedPath)) {
        res.setHeader("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
        return;
      }
      if (normalizedPath.endsWith(".html")) {
        res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
      }
    },
  }));
  app.get(/^\/(?!api(?:\/|$)).*/, (_req, res) => {
    res.set("Cache-Control", "public, max-age=0, must-revalidate");
    res.sendFile(frontendIndexPath);
  });
} else {
  
  app.get("/", (_req, res) => {
    res.json({ ok: true, name: "ZMH Backend API", version: "1.0.0" });
  });
}

app.use(notFound);
app.use(errorHandler);

connectDb().then(() => {
  app.listen(port, () => {
    console.log(`ZMH backend running on port ${port}`);
  });
});
