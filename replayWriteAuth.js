const crypto = require("node:crypto");

const WRITE_SECRET_HEADER = "x-backend-write-secret";

function secretsMatch(expectedSecret, providedSecret) {
  if (
    typeof expectedSecret !== "string" ||
    expectedSecret.length === 0 ||
    typeof providedSecret !== "string" ||
    providedSecret.length === 0
  ) {
    return false;
  }

  // Hash both inputs first so timingSafeEqual always compares equal-length buffers.
  const expectedDigest = crypto
    .createHash("sha256")
    .update(expectedSecret, "utf8")
    .digest();
  const providedDigest = crypto
    .createHash("sha256")
    .update(providedSecret, "utf8")
    .digest();

  return crypto.timingSafeEqual(expectedDigest, providedDigest);
}

function createReplayWriteAuth(configuredSecret) {
  return function requireReplayWriteAuth(req, res, next) {
    if (typeof configuredSecret !== "string" || configuredSecret.length === 0) {
      return res.status(503).json({
        success: false,
        error: "Replay writes are temporarily unavailable",
      });
    }

    const providedSecret = req.get(WRITE_SECRET_HEADER);
    if (!secretsMatch(configuredSecret, providedSecret)) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized replay write",
      });
    }

    return next();
  };
}

module.exports = {
  WRITE_SECRET_HEADER,
  createReplayWriteAuth,
  secretsMatch,
};
