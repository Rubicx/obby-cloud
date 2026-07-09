const express = require("express");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();

app.use(express.json({ limit: "10mb" }));

const BUCKET_NAME = process.env.SUPABASE_REPLAY_BUCKET || "obby-replays";
const LEADERBOARD_TABLE = process.env.SUPABASE_LEADERBOARD_TABLE || "leaderboard";
const REPLAY_DELETE_SECRET = process.env.REPLAY_DELETE_SECRET || "";

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
    req.body?.deleteSecret ||
    req.query?.deleteSecret ||
    ""
  );
}

function isDeleteAuthorized(req) {
  if (!REPLAY_DELETE_SECRET) {
    return true;
  }

  return getDeleteSecretFromRequest(req) === REPLAY_DELETE_SECRET;
}

async function saveLeaderboardRow({
  userId,
  playerName,
  obbyId,
  timeTaken,
  replayPath,
}) {
  // Keep only one database row per user per obby.
  const { error: deleteError } = await supabase
    .from(LEADERBOARD_TABLE)
    .delete()
    .eq("player_id", String(userId))
    .eq("obby_id", String(obbyId));

  if (deleteError) {
    return deleteError;
  }

  const { error: insertError } = await supabase
    .from(LEADERBOARD_TABLE)
    .insert({
      player_id: String(userId),
      player_name: playerName || null,
      obby_id: String(obbyId),
      time_taken: Number(timeTaken),
      replay_path: replayPath,
    });

  return insertError;
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
    .select("player_id, player_name, obby_id, time_taken, replay_path, created_at")
    .eq("player_id", String(userId))
    .eq("obby_id", String(obbyId))
    .order("created_at", { ascending: false })
    .limit(1);

  const row = Array.isArray(leaderboardRows) ? leaderboardRows[0] : null;
  const metadata = extracted.metadata || {};

  const payload = {
    success: true,

    userId: String(userId),
    obbyId: String(obbyId),
    replayPath,

    replayData: extracted.replayData,

    playerName: row?.player_name ?? metadata.playerName ?? null,
    timeTaken: row?.time_taken ?? metadata.timeTaken ?? null,
    createdAt: row?.created_at ?? metadata.savedAt ?? null,

    avgFPS: metadata.avgFPS ?? metadata.averageFPS ?? metadata.AverageFPS ?? null,
    timeOfCompletion: metadata.timeOfCompletion ?? metadata.TimeOfCompletion ?? null,
    completionData: metadata.completionData ?? metadata.CompletionData ?? {},
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
  };

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

    const replayFileBody = {
      userId: String(userId),
      playerName: playerName || null,
      obbyId: String(obbyId),
      timeTaken: Number(timeTaken),

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

    const dbError = await saveLeaderboardRow({
      userId,
      playerName,
      obbyId,
      timeTaken,
      replayPath,
    });

    if (dbError) {
      return res.status(500).json({
        success: false,
        error: dbError.message,
      });
    }

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
  const { obbyId } = req.params;

  const { data, error } = await supabase
    .from(LEADERBOARD_TABLE)
    .select("id, player_id, player_name, obby_id, time_taken, replay_path, created_at")
    .eq("obby_id", obbyId)
    .order("time_taken", { ascending: true })
    .limit(50);

  if (error) {
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }

  res.json({
    success: true,
    rows: data,
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});