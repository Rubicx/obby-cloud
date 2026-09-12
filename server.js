const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const {
  createReplayWriteAuth,
  secretMatchesHex,
  secretsMatch,
} = require("./replayWriteAuth");
const { saveLeaderboardRow } = require("./leaderboardStore");
const { purgeObbyReplayData } = require("./obbyPurge");
const { purgePlayerReplayData } = require("./playerPurge");
const {
  buildModerationDiscordMessage,
  postDiscordWebhook,
} = require("./moderationWebhook");
const {
  getExpectedObbyVersion,
  normalizeObbyVersion,
} = require("./obbyVersionStore");
require("dotenv").config();

const app = express();

const BACKEND_WRITE_SECRET = process.env.BACKEND_WRITE_SECRET || "";

// Authenticate replay uploads before parsing their potentially large JSON bodies.
// Replay reads stay public; deletion continues to use its existing credential.
app.use(
  "/save-replay",
  createReplayWriteAuth(BACKEND_WRITE_SECRET)
);
app.use(
  "/moderation-webhook",
  createReplayWriteAuth(BACKEND_WRITE_SECRET)
);
app.use(express.json({ limit: "10mb" }));

const BUCKET_NAME = process.env.SUPABASE_REPLAY_BUCKET || "obby-replays";
const LEADERBOARD_TABLE = process.env.SUPABASE_LEADERBOARD_TABLE || "leaderboard";
const REPLAY_DELETE_SECRET = process.env.REPLAY_DELETE_SECRET || "";
const DISCORD_MODERATION_WEBHOOK_URL = process.env.DISCORD_MODERATION_WEBHOOK_URL || "";
const LEADERBOARD_CACHE_TTL_MS = 15_000;
const LEADERBOARD_CACHE_MAX_ENTRIES = 250;

const leaderboardCache = new Map();
const leaderboardLoads = new Map();
const deliveredModerationActions = new Map();
const MODERATION_ACTION_TTL_MS = 10 * 60 * 1000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function getReplayPath(userId, obbyId) {
  return `${String(obbyId)}/${String(userId)}.json`;
}

function getMetadataFromBody(body) {
  return {
    avgFPS: body.avgFPS ?? body.averageFPS ?? body.AverageFPS ?? null,
    timeOfCompletion: body.timeOfCompletion ?? body.TimeOfCompletion ?? null,
    completionData: body.completionData ?? body.CompletionData ?? {},
  };
}

function getReplayStatusFromBody(body) {
  const metadata = body && typeof body.metadata === "object" ? body.metadata : {};
  const replayRemoved = body.replayRemoved === true || metadata.replayRemoved === true;
  const explicitHasReplay = body.hasReplayData ?? metadata.hasReplayData;

  return explicitHasReplay !== false && !replayRemoved;
}

function invalidateLeaderboardCache(obbyId) {
  leaderboardCache.delete(String(obbyId));
}

function pruneModerationActionCache(now = Date.now()) {
  for (const [actionId, expiresAt] of deliveredModerationActions) {
    if (expiresAt <= now) {
      deliveredModerationActions.delete(actionId);
    }
  }
}

function trimLeaderboardCache() {
  while (leaderboardCache.size > LEADERBOARD_CACHE_MAX_ENTRIES) {
    const oldestKey = leaderboardCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    leaderboardCache.delete(oldestKey);
  }
}

async function loadLeaderboardSnapshot(obbyId, expectedObbyVersion) {
  const cacheKey = String(obbyId);
  const now = Date.now();
  const cached = leaderboardCache.get(cacheKey);

  if (
    cached
    && cached.expiresAt > now
    && cached.expectedObbyVersion === expectedObbyVersion
  ) {
    // Refresh insertion order so the Map also acts as a small LRU.
    leaderboardCache.delete(cacheKey);
    leaderboardCache.set(cacheKey, cached);
    return { rows: cached.rows, cacheHit: true };
  }

  if (cached) {
    leaderboardCache.delete(cacheKey);
  }

  const activeLoad = leaderboardLoads.get(cacheKey);
  if (activeLoad && activeLoad.expectedObbyVersion === expectedObbyVersion) {
    const rows = await activeLoad.promise;
    return { rows, cacheHit: true, coalesced: true };
  }

  const loadPromise = (async () => {
    let query = supabase
      .from(LEADERBOARD_TABLE)
      .select([
        "id",
        "player_id",
        "player_name",
        "obby_id",
        "obby_version",
        "time_taken",
        "replay_path",
        "created_at",
        "updated_at",
        "average_fps",
        "time_of_completion",
        "completion_data",
        "has_replay_data",
        "replay_revision",
        "replay_digest",
        "submission_id",
      ].join(", "))
      .eq("obby_id", obbyId)
      .order("time_taken", { ascending: true })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });

    if (expectedObbyVersion) {
      query = query.eq("obby_version", expectedObbyVersion);
    }

    const { data, error } = await query.limit(100);
    if (error) {
      throw error;
    }

    const rows = Array.isArray(data) ? data : [];
    leaderboardCache.set(cacheKey, {
      rows,
      expectedObbyVersion,
      expiresAt: Date.now() + LEADERBOARD_CACHE_TTL_MS,
    });
    trimLeaderboardCache();
    return rows;
  })();

  leaderboardLoads.set(cacheKey, {
    expectedObbyVersion,
    promise: loadPromise,
  });

  try {
    return { rows: await loadPromise, cacheHit: false };
  } finally {
    const current = leaderboardLoads.get(cacheKey);
    if (current && current.promise === loadPromise) {
      leaderboardLoads.delete(cacheKey);
    }
  }
}

async function backfillLeaderboardMetadata(userId, obbyId, replayPath, payload) {
  const update = {
    player_name: payload.playerName ?? null,
    replay_path: replayPath,
    average_fps: Number.isFinite(Number(payload.avgFPS)) ? Number(payload.avgFPS) : null,
    time_of_completion: Number.isFinite(Number(payload.timeOfCompletion))
      ? Math.floor(Number(payload.timeOfCompletion))
      : null,
    completion_data: payload.completionData && typeof payload.completionData === "object"
      ? payload.completionData
      : {},
    has_replay_data: payload.hasReplayData !== false,
    replay_revision: payload.replayRevision ? String(payload.replayRevision) : null,
    replay_digest: payload.replayDigest ? String(payload.replayDigest) : null,
    submission_id: payload.submissionId ? String(payload.submissionId) : null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from(LEADERBOARD_TABLE)
    .update(update)
    .eq("player_id", String(userId))
    .eq("obby_id", String(obbyId));

  if (!error) {
    invalidateLeaderboardCache(obbyId);
  }
}

function normalizeReplayData(replayData) {
  if (typeof replayData === "string") {
    return replayData;
  }

  if (replayData === undefined || replayData === null) {
    return "";
  }

  return JSON.stringify(replayData);
}

function extractReplayDataFromStoredFile(text) {
  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      replayData: text,
      metadata: {},
    };
  }

  if (typeof parsed === "string") {
    return {
      replayData: parsed,
      metadata: {},
    };
  }

  if (parsed && typeof parsed === "object") {
    let replayData = "";

    if (typeof parsed.replayData === "string") {
      replayData = parsed.replayData;
    } else if (typeof parsed.replay === "string") {
      replayData = parsed.replay;
    } else if (typeof parsed.encodedReplay === "string") {
      replayData = parsed.encodedReplay;
    } else if (typeof parsed.ReplayStack === "string") {
      replayData = parsed.ReplayStack;
    } else if (parsed.replayData !== undefined && parsed.replayData !== null) {
      replayData = JSON.stringify(parsed.replayData);
    } else {
      replayData = JSON.stringify(parsed);
    }

    return {
      replayData,
      metadata: parsed,
    };
  }

  return {
    replayData: String(parsed ?? ""),
    metadata: {},
  };
}

function getDeleteSecretFromRequest(req) {
  return (
    req.get("x-backend-delete-secret") ||
    req.get("x-replay-delete-secret") ||
    req.get("x-backend-write-secret") ||
    req.body?.deleteSecret ||
    req.query?.deleteSecret ||
    ""
  );
}

function getDeleteSecretHexFromRequest(req) {
  return (
    req.get("x-backend-delete-secret-hex")
    || req.get("x-replay-delete-secret-hex")
    || req.get("x-backend-write-secret-hex")
    || ""
  );
}

function isDeleteAuthorized(req) {
  // Missing configuration must disable deletion instead of exposing it.
  const suppliedSecret = getDeleteSecretFromRequest(req);
  const suppliedHex = getDeleteSecretHexFromRequest(req);
  return secretsMatch(REPLAY_DELETE_SECRET, suppliedSecret)
    || secretsMatch(BACKEND_WRITE_SECRET, suppliedSecret)
    || secretMatchesHex(REPLAY_DELETE_SECRET, suppliedHex)
    || secretMatchesHex(BACKEND_WRITE_SECRET, suppliedHex);
}

async function deleteLeaderboardRows(userId, obbyId, replayPath) {
  const { data, error } = await supabase
    .from(LEADERBOARD_TABLE)
    .delete()
    .eq("player_id", String(userId))
    .eq("obby_id", String(obbyId))
    .select("id, player_id, obby_id, replay_path");

  if (error) {
    return {
      error,
      deletedRows: [],
    };
  }

  // Safety fallback for older rows where player/obby columns may be weird but replay_path is correct.
  if ((!data || data.length === 0) && replayPath) {
    const fallback = await supabase
      .from(LEADERBOARD_TABLE)
      .delete()
      .eq("replay_path", replayPath)
      .select("id, player_id, obby_id, replay_path");

    return {
      error: fallback.error,
      deletedRows: fallback.data || [],
    };
  }

  return {
    error: null,
    deletedRows: data || [],
  };
}

async function deleteReplay(userId, obbyId) {
  if (!userId || !obbyId) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Missing userId or obbyId",
      },
    };
  }

  const replayPath = getReplayPath(userId, obbyId);

  const { data: removedObjects, error: removeError } = await supabase.storage
    .from(BUCKET_NAME)
    .remove([replayPath]);

  if (removeError) {
    return {
      status: 500,
      body: {
        success: false,
        error: removeError.message,
        replayPath,
      },
    };
  }

  const {
    error: leaderboardDeleteError,
    deletedRows,
  } = await deleteLeaderboardRows(userId, obbyId, replayPath);

  if (leaderboardDeleteError) {
    return {
      status: 500,
      body: {
        success: false,
        error: leaderboardDeleteError.message,
        replayPath,
        removedObjects: removedObjects || [],
      },
    };
  }

  invalidateLeaderboardCache(obbyId);

  return {
    status: 200,
    body: {
      success: true,
      userId: String(userId),
      obbyId: String(obbyId),
      replayPath,
      removedObjects: removedObjects || [],
      deletedRows: deletedRows || [],
    },
  };
}

async function loadReplay(userId, obbyId) {
  if (!userId || !obbyId) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Missing userId or obbyId",
      },
    };
  }

  const replayPath = getReplayPath(userId, obbyId);

  const { data: fileData, error: downloadError } = await supabase.storage
    .from(BUCKET_NAME)
    .download(replayPath);

  if (downloadError) {
    return {
      status: 404,
      body: {
        success: false,
        error: downloadError.message,
        replayPath,
      },
    };
  }

  const fileText = await fileData.text();
  const extracted = extractReplayDataFromStoredFile(fileText);

  if (typeof extracted.replayData !== "string" || extracted.replayData === "") {
    return {
      status: 404,
      body: {
        success: false,
        error: "Replay file exists, but replayData is empty",
        replayPath,
      },
    };
  }

  const { data: leaderboardRows } = await supabase
    .from(LEADERBOARD_TABLE)
    .select([
      "player_id",
      "player_name",
      "obby_id",
      "time_taken",
      "replay_path",
      "created_at",
      "average_fps",
      "time_of_completion",
      "completion_data",
      "has_replay_data",
      "replay_revision",
      "replay_digest",
      "submission_id",
    ].join(", "))
    .eq("player_id", String(userId))
    .eq("obby_id", String(obbyId))
    .order("created_at", { ascending: false })
    .limit(1);

  const row = Array.isArray(leaderboardRows) ? leaderboardRows[0] : null;
  const metadata = extracted.metadata || {};
  const replayFileCompletionData = metadata.completionData ?? metadata.CompletionData;
  const hasReplayFileCompletionData = replayFileCompletionData
    && typeof replayFileCompletionData === "object"
    && Object.keys(replayFileCompletionData).length > 0;
  const replayFileCompletionTime = metadata.timeOfCompletion
    ?? metadata.TimeOfCompletion
    ?? null;
  const replayFileState = metadata.hasReplayData
    ?? metadata.has_replay_data
    ?? (metadata.replayRemoved === true ? false : null);

  const payload = {
    success: true,

    userId: String(userId),
    obbyId: String(obbyId),
    replayPath,

    replayData: extracted.replayData,

    playerName: row?.player_name ?? metadata.playerName ?? null,
    timeTaken: row?.time_taken ?? metadata.timeTaken ?? null,
    createdAt: row?.created_at ?? metadata.savedAt ?? null,

    avgFPS: row?.average_fps
      ?? metadata.avgFPS
      ?? metadata.averageFPS
      ?? metadata.AverageFPS
      ?? null,
    timeOfCompletion: replayFileCompletionTime ?? row?.time_of_completion ?? null,
    completionData: hasReplayFileCompletionData
      ? replayFileCompletionData
      : (row?.completion_data ?? {}),

    hasReplayData: replayFileState ?? row?.has_replay_data ?? true,

    obbyVersion: metadata.obbyVersion ?? metadata.ObbyVersion ?? null,
    submissionId: row?.submission_id
      ?? metadata.submissionId
      ?? metadata.SubmissionId
      ?? null,
    replayRevision: row?.replay_revision
      ?? metadata.replayRevision
      ?? metadata.ReplayRevision
      ?? null,
    replayDigest: row?.replay_digest
      ?? metadata.replayDigest
      ?? metadata.ReplayDigest
      ?? null,
  };

  payload.data = {
    userId: payload.userId,
    obbyId: payload.obbyId,
    replayPath: payload.replayPath,
    replayData: payload.replayData,
    playerName: payload.playerName,
    timeTaken: payload.timeTaken,
    createdAt: payload.createdAt,
    avgFPS: payload.avgFPS,
    timeOfCompletion: payload.timeOfCompletion,
    completionData: payload.completionData,
    obbyVersion: payload.obbyVersion,
    submissionId: payload.submissionId,
    replayRevision: payload.replayRevision,
    replayDigest: payload.replayDigest,
    hasReplayData: payload.hasReplayData,
  };

  // Older rows predate summary metadata. Opening a replay upgrades its row so
  // future leaderboard pages can remain summary-only.
  const needsMetadataBackfill = row && (
    row.time_of_completion == null
    || row.average_fps == null
    || row.completion_data == null
    || row.has_replay_data == null
    || (hasReplayFileCompletionData && Object.keys(row.completion_data || {}).length === 0)
    || (
      Number.isFinite(Number(replayFileCompletionTime))
      && Number(row.time_of_completion) !== Math.floor(Number(replayFileCompletionTime))
    )
    || (replayFileState != null && row.has_replay_data !== replayFileState)
  );
  if (needsMetadataBackfill) {
    void backfillLeaderboardMetadata(userId, obbyId, replayPath, payload).catch((error) => {
      console.warn("leaderboard metadata backfill failed", {
        userId: String(userId),
        obbyId: String(obbyId),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return {
    status: 200,
    body: payload,
  };
}

app.get("/", (req, res) => {
  res.send("Obby cloud backend is running");
});

app.post("/save-replay", async (req, res) => {
  try {
    const {
      userId,
      playerName,
      obbyId,
      timeTaken,
      replayData,
    } = req.body;

    if (
      !userId ||
      !obbyId ||
      timeTaken === undefined ||
      replayData === undefined ||
      replayData === null
    ) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    const replayPath = getReplayPath(userId, obbyId);
    const metadata = getMetadataFromBody(req.body);
    const hasReplayData = getReplayStatusFromBody(req.body);
    const obbyVersion = normalizeObbyVersion(
      req.body.obbyVersion ?? req.body.ObbyVersion
    );
    const expectedObbyVersion = await getExpectedObbyVersion(supabase, obbyId);
    if (expectedObbyVersion && obbyVersion !== expectedObbyVersion) {
      return res.status(409).json({
        success: false,
        error: "Outdated obby version",
        expectedObbyVersion,
      });
    }

    const replayFileBody = {
      userId: String(userId),
      playerName: playerName || null,
      obbyId: String(obbyId),
      timeTaken: Number(timeTaken),

      obbyVersion,
      submissionId: req.body.submissionId ?? req.body.SubmissionId ?? null,
      replayRevision: req.body.replayRevision ?? req.body.ReplayRevision ?? null,
      replayDigest: req.body.replayDigest ?? req.body.ReplayDigest ?? null,

      replayData: normalizeReplayData(replayData),

      avgFPS: metadata.avgFPS,
      timeOfCompletion: metadata.timeOfCompletion,
      completionData: metadata.completionData,

      savedAt: new Date().toISOString(),
    };

    const { error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(replayPath, JSON.stringify(replayFileBody), {
        contentType: "application/json",
        upsert: true,
      });

    if (uploadError) {
      return res.status(500).json({
        success: false,
        error: uploadError.message,
      });
    }

    const dbError = await saveLeaderboardRow(
      supabase,
      LEADERBOARD_TABLE,
      {
        userId,
        playerName,
        obbyId,
        obbyVersion,
        timeTaken,
        replayPath,
        averageFPS: metadata.avgFPS,
        timeOfCompletion: metadata.timeOfCompletion,
        completionData: metadata.completionData,
        hasReplayData,
        replayRevision: replayFileBody.replayRevision,
        replayDigest: replayFileBody.replayDigest,
        submissionId: replayFileBody.submissionId,
      }
    );

    if (dbError) {
      return res.status(500).json({
        success: false,
        error: dbError.message,
      });
    }

    invalidateLeaderboardCache(obbyId);

    res.json({
      success: true,
      replayPath,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: String(err),
    });
  }
});

app.post("/delete-replay", async (req, res) => {
  if (!isDeleteAuthorized(req)) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized delete request",
    });
  }

  const result = await deleteReplay(req.body.userId, req.body.obbyId);
  res.status(result.status).json(result.body);
});

app.delete("/delete-replay", async (req, res) => {
  if (!isDeleteAuthorized(req)) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized delete request",
    });
  }

  const result = await deleteReplay(req.query.userId, req.query.obbyId);
  res.status(result.status).json(result.body);
});

app.delete("/replay", async (req, res) => {
  if (!isDeleteAuthorized(req)) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized delete request",
    });
  }

  const userId = req.query.userId ?? req.body?.userId;
  const obbyId = req.query.obbyId ?? req.body?.obbyId;

  const result = await deleteReplay(userId, obbyId);
  res.status(result.status).json(result.body);
});

app.delete("/obby-replays/:obbyId/:fileName", async (req, res) => {
  if (!isDeleteAuthorized(req)) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized delete request",
    });
  }

  const userId = String(req.params.fileName).replace(/\.json$/i, "");
  const obbyId = req.params.obbyId;

  const result = await deleteReplay(userId, obbyId);
  res.status(result.status).json(result.body);
});

app.get("/load-replay", async (req, res) => {
  const result = await loadReplay(req.query.userId, req.query.obbyId);
  res.status(result.status).json(result.body);
});

app.get("/get-replay", async (req, res) => {
  const result = await loadReplay(req.query.userId, req.query.obbyId);
  res.status(result.status).json(result.body);
});

app.get("/replay", async (req, res) => {
  const result = await loadReplay(req.query.userId, req.query.obbyId);
  res.status(result.status).json(result.body);
});

app.post("/load-replay", async (req, res) => {
  const result = await loadReplay(req.body.userId, req.body.obbyId);
  res.status(result.status).json(result.body);
});

app.get("/obby-replays/:obbyId/:fileName", async (req, res) => {
  const userId = String(req.params.fileName).replace(/\.json$/i, "");
  const obbyId = req.params.obbyId;

  const result = await loadReplay(userId, obbyId);
  res.status(result.status).json(result.body);
});

app.get("/leaderboard/:obbyId", async (req, res) => {
  const startedAt = Date.now();
  const { obbyId } = req.params;
  const parsedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 100)
    : 50;

  let expectedObbyVersion;
  try {
    expectedObbyVersion = await getExpectedObbyVersion(supabase, obbyId);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let snapshot;
  try {
    snapshot = await loadLeaderboardSnapshot(obbyId, expectedObbyVersion);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const rows = snapshot.rows.slice(0, limit);

  res.json({
    success: true,
    limit,
    rows,
    hasMore: snapshot.rows.length > rows.length,
    cacheHit: snapshot.cacheHit === true,
    coalesced: snapshot.coalesced === true,
    durationMs: Date.now() - startedAt,
  });
});

app.post("/purge-obby-replays", async (req, res) => {
  if (!isDeleteAuthorized(req)) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized purge request",
    });
  }

  const result = await purgeObbyReplayData(supabase, {
    bucketName: BUCKET_NAME,
    leaderboardTable: LEADERBOARD_TABLE,
    obbyId: req.body.obbyId,
    replacementVersion: req.body.replacementVersion,
  });

  if (result.status >= 200 && result.status < 300) {
    invalidateLeaderboardCache(req.body.obbyId);
  }

  res.status(result.status).json(result.body);
});

app.post("/purge-player-replays", async (req, res) => {
  if (!isDeleteAuthorized(req)) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized player purge request",
    });
  }

  const result = await purgePlayerReplayData(supabase, {
    bucketName: BUCKET_NAME,
    leaderboardTable: LEADERBOARD_TABLE,
    playerId: req.body.playerId ?? req.body.userId,
  });

  if (result.status >= 200 && result.status < 300) {
    for (const obbyId of result.body.obbyIds || []) {
      invalidateLeaderboardCache(obbyId);
    }
  }

  res.status(result.status).json(result.body);
});

app.post("/moderation-webhook", async (req, res) => {
  const actionId = String(req.body?.actionId ?? "").trim().slice(0, 200);
  if (!actionId) {
    return res.status(400).json({
      success: false,
      error: "Missing actionId",
    });
  }

  pruneModerationActionCache();
  if (deliveredModerationActions.has(actionId)) {
    return res.json({ success: true, duplicate: true });
  }

  try {
    const delivery = await postDiscordWebhook(
      DISCORD_MODERATION_WEBHOOK_URL,
      buildModerationDiscordMessage(req.body)
    );

    deliveredModerationActions.set(actionId, Date.now() + MODERATION_ACTION_TTL_MS);
    return res.json({
      success: true,
      attempts: delivery.attempts,
      discordStatus: delivery.status,
    });
  } catch (error) {
    console.error("moderation webhook delivery failed", {
      actionId,
      error: error instanceof Error ? error.message : String(error),
    });

    return res.status(502).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
