function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`${name} is required. Set ${name} before starting the server.`);
  }
  return String(value);
}

const JWT_SECRET = requiredEnv("JWT_SECRET");

module.exports = { JWT_SECRET, requiredEnv };
