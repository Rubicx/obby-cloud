const crypto = require("node:crypto");

const WRITE_SECRET_HEADER = "x-backend-write-secret";
const WRITE_SECRET_HEX_HEADER = "x-backend-write-secret-hex";

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

function secretMatchesHex(expectedSecret, providedHex) {
  if (
    typeof expectedSecret !== "string"
    || expectedSecret.length === 0
    || typeof providedHex !== "string"
    || providedHex.length === 0
    || providedHex.length % 2 !== 0
    || !/^[0-9a-f]+$/i.test(providedHex)
  ) {
    return false;
  }

  return secretsMatch(
    Buffer.from(expectedSecret, "utf8").toString("hex"),
    providedHex.toLowerCase()
  );
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
    const providedHex = req.get(WRITE_SECRET_HEX_HEADER);
    if (
      !secretsMatch(configuredSecret, providedSecret)
      && !secretMatchesHex(configuredSecret, providedHex)
    ) {
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
  WRITE_SECRET_HEX_HEADER,
  createReplayWriteAuth,
  secretMatchesHex,
  secretsMatch,
};
