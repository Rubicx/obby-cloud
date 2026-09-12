const DEFAULT_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 3;
const MAX_TEXT_LENGTH = 1000;

function boundedText(value, fallback = "", maximum = MAX_TEXT_LENGTH) {
  const text = String(value ?? "").trim() || fallback;
  return text.slice(0, maximum);
}

function normalizeUnixTimestamp(value, fallback) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? Math.floor(timestamp)
    : fallback;
}

function buildModerationDiscordMessage(payload) {
  const restrictionType = payload?.restrictionType === "GameAccess"
    ? "Game Access"
    : payload?.restrictionType === "LeaderboardSubmission"
      ? "Leaderboard Submission"
      : boundedText(payload?.restrictionType, "Unknown", 100);
  const targetUserId = boundedText(payload?.targetUserId, "0", 30);
  const targetUsername = boundedText(payload?.targetUsername, `User${targetUserId}`, 50);
  const targetDisplayName = boundedText(payload?.targetDisplayName, targetUsername, 50);
  const adminUserId = boundedText(payload?.adminUserId, "0", 30);
  const adminName = boundedText(payload?.adminName, `User${adminUserId}`, 50);
  const reason = boundedText(payload?.reason, "No reason provided", 1000);
  const evidence = boundedText(payload?.evidence, "None provided", 1000);
  const createdAt = normalizeUnixTimestamp(payload?.createdAt, Math.floor(Date.now() / 1000));
  const expiresAt = normalizeUnixTimestamp(payload?.expiresAt, 0);
  const targetLabel = targetDisplayName !== targetUsername
    ? `${targetDisplayName} (@${targetUsername})`
    : `@${targetUsername}`;

  return {
    username: "TPP Moderation",
    allowed_mentions: { parse: [] },
    embeds: [{
      title: "TPP - Restriction Applied",
      description: "A player restriction was applied through the in-game Admin Tools panel.",
      color: payload?.restrictionType === "GameAccess" ? 16711730 : 16755200,
      fields: [
        { name: "Restriction", value: restrictionType, inline: true },
        {
          name: "User",
          value: `${targetLabel}\n[Roblox profile](https://www.roblox.com/users/${targetUserId}/profile)\nUserId: \`${targetUserId}\``,
          inline: true,
        },
        {
          name: "Applied by",
          value: `@${adminName}\nUserId: \`${adminUserId}\``,
          inline: true,
        },
        { name: "Reason", value: reason, inline: false },
        { name: "Evidence", value: evidence, inline: false },
        {
          name: "Expiration",
          value: expiresAt > 0 ? `<t:${expiresAt}:F>\n<t:${expiresAt}:R>` : "Permanent",
          inline: true,
        },
        {
          name: "Time of action",
          value: `<t:${createdAt}:F>\n<t:${createdAt}:R>`,
          inline: true,
        },
      ],
      footer: { text: "Sent from TPP Admin Tools" },
      timestamp: new Date(createdAt * 1000).toISOString(),
    }],
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function postDiscordWebhook(webhookUrl, payload, options = {}) {
  if (typeof webhookUrl !== "string" || !/^https:\/\/(?:canary\.|ptb\.)?discord\.com\/api\/webhooks\//.test(webhookUrl)) {
    throw new Error("Discord moderation webhook is not configured");
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok) {
        return { attempts: attempt, status: response.status };
      }

      const responseText = await response.text();
      lastError = new Error(`Discord returned ${response.status}: ${responseText.slice(0, 300)}`);

      if (response.status !== 429 && response.status < 500) {
        lastError.retryable = false;
        throw lastError;
      }

      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      if (attempt < MAX_ATTEMPTS) {
        await delay(Number.isFinite(retryAfterSeconds)
          ? Math.min(Math.max(retryAfterSeconds * 1000, 100), 5000)
          : 250 * (2 ** (attempt - 1)));
      }
    } catch (error) {
      lastError = error;
      if (error?.retryable === false) {
        break;
      }
      if (attempt < MAX_ATTEMPTS) {
        await delay(250 * (2 ** (attempt - 1)));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("Discord webhook delivery failed");
}

module.exports = {
  buildModerationDiscordMessage,
  postDiscordWebhook,
};
