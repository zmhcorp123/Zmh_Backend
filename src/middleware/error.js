function notFound(req, res, next) {
  const error = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
}

function errorHandler(error, _req, res, _next) {
  if (error.code === "EBADCSRFTOKEN") {
    return res.status(403).json({
      ok: false,
      message: "Invalid or missing CSRF token.",
    });
  }

  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({
    ok: false,
    message: error.message || "Server error",
  });
}

module.exports = { notFound, errorHandler };
