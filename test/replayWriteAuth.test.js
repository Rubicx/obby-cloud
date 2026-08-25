const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createReplayWriteAuth,
  secretsMatch,
} = require("../replayWriteAuth");

function runMiddleware(configuredSecret, providedSecret) {
  let statusCode = null;
  let responseBody = null;
  let nextCalled = false;

  const req = {
    get(name) {
      assert.equal(name, "x-backend-write-secret");
      return providedSecret;
    },
  };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  createReplayWriteAuth(configuredSecret)(req, res, () => {
    nextCalled = true;
  });

  return { statusCode, responseBody, nextCalled };
}

test("accepts an exact write-secret match", () => {
  const result = runMiddleware("correct-secret", "correct-secret");

  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, null);
  assert.equal(result.responseBody, null);
});

test("rejects a missing write-secret header", () => {
  const result = runMiddleware("correct-secret", undefined);

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
  assert.equal(result.responseBody.error, "Unauthorized replay write");
});

test("rejects an incorrect write-secret header", () => {
  const result = runMiddleware("correct-secret", "wrong-secret");

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 401);
});

test("fails closed when the server secret is missing", () => {
  const result = runMiddleware("", "anything");

  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 503);
  assert.equal(result.responseBody.error, "Replay writes are temporarily unavailable");
});

test("secret comparison requires non-empty strings and exact content", () => {
  assert.equal(secretsMatch("same", "same"), true);
  assert.equal(secretsMatch("same", "Same"), false);
  assert.equal(secretsMatch("", ""), false);
  assert.equal(secretsMatch("same", undefined), false);
});

test("delete-style authorization also fails closed without configuration", () => {
  assert.equal(secretsMatch("", "anything"), false);
  assert.equal(secretsMatch(undefined, undefined), false);
});
