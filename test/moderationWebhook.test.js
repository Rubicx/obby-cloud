const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildModerationDiscordMessage,
  postDiscordWebhook,
} = require("../moderationWebhook");

test("builds a bounded moderation embed without mentions", () => {
  const message = buildModerationDiscordMessage({
    restrictionType: "GameAccess",
    targetUserId: 2472617408,
    targetUsername: "target",
    targetDisplayName: "Target",
    adminUserId: 730965488,
    adminName: "mp5",
    reason: "testing",
    evidence: "https://example.com/evidence",
    createdAt: 1789257600,
  });

  assert.deepEqual(message.allowed_mentions, { parse: [] });
  assert.equal(message.embeds[0].fields[0].value, "Game Access");
  assert.match(message.embeds[0].fields[1].value, /2472617408/);
  assert.equal(message.embeds[0].fields[3].value, "testing");
});

test("retries a transient Discord response", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return {
      ok: attempts === 2,
      status: attempts === 2 ? 204 : 500,
      headers: { get: () => null },
      text: async () => "temporary failure",
    };
  };

  const result = await postDiscordWebhook(
    "https://discord.com/api/webhooks/1/token",
    { embeds: [] },
    { fetchImpl, timeoutMs: 100 }
  );

  assert.equal(result.attempts, 2);
  assert.equal(attempts, 2);
});

test("rejects non-Discord webhook URLs", async () => {
  await assert.rejects(
    postDiscordWebhook("https://example.com/webhook", {}, { fetchImpl: async () => ({ ok: true }) }),
    /not configured/
  );
});

test("does not retry a permanent Discord rejection", async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return {
      ok: false,
      status: 400,
      headers: { get: () => null },
      text: async () => "invalid payload",
    };
  };

  await assert.rejects(
    postDiscordWebhook(
      "https://discord.com/api/webhooks/1/token",
      { embeds: [] },
      { fetchImpl, timeoutMs: 100 }
    ),
    /Discord returned 400/
  );
  assert.equal(attempts, 1);
});
