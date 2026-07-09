const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(value) {
  const email = normalizeEmail(value);
  return Boolean(email && email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email));
}

function validateEmail(value, message = "Enter a valid email address") {
  const email = normalizeEmail(value);
  if (!isValidEmail(email)) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }
  return email;
}

module.exports = { isValidEmail, normalizeEmail, validateEmail };
