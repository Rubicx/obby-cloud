const STORAGE_REMOVE_BATCH_SIZE = 1000;
const LEADERBOARD_READ_PAGE_SIZE = 1000;

function normalizePlayerId(value) {
  const playerId = String(value ?? "").trim();

  if (!/^\d+$/.test(playerId)) {
    return null;
  }

  const numeric = Number(playerId);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    return null;
  }

  return playerId;
}

function normalizeStoredReplayPath(value) {
  const path = String(value ?? "").trim();

  if (
    !path
    || path.length > 512
    || path.startsWith("/")
    || path.includes("\\")
    || path.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    return null;
  }

  return path;
}

function getReplayPathFromRow(row, playerId) {
  const storedPath = normalizeStoredReplayPath(row?.replay_path);
  if (storedPath) {
    return storedPath;
  }

  const obbyId = String(row?.obby_id ?? "").trim();
  if (!obbyId || obbyId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(obbyId)) {
    return null;
  }

  return `${obbyId}/${playerId}.json`;
}

async function listPlayerLeaderboardRows(supabase, leaderboardTable, playerId) {
  const rows = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from(leaderboardTable)
      .select("id, player_id, obby_id, replay_path")
      .eq("player_id", playerId)
      .order("id", { ascending: true })
      .range(offset, offset + LEADERBOARD_READ_PAGE_SIZE - 1);

    if (error) {
      throw error;
    }

    const page = Array.isArray(data) ? data : [];
    rows.push(...page);

    if (page.length < LEADERBOARD_READ_PAGE_SIZE) {
      break;
    }

    offset += page.length;
  }

  return rows;
}

async function removeReplayPaths(supabase, bucketName, replayPaths) {
  let removedObjectCount = 0;

  for (let index = 0; index < replayPaths.length; index += STORAGE_REMOVE_BATCH_SIZE) {
    const batch = replayPaths.slice(index, index + STORAGE_REMOVE_BATCH_SIZE);
    const { data, error } = await supabase.storage
      .from(bucketName)
      .remove(batch);

    if (error) {
      throw error;
    }

    removedObjectCount += Array.isArray(data) ? data.length : 0;
  }

  return removedObjectCount;
}

async function purgePlayerReplayData(
  supabase,
  { bucketName, leaderboardTable, playerId }
) {
  const normalizedPlayerId = normalizePlayerId(playerId);
  if (!normalizedPlayerId) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Invalid playerId",
      },
    };
  }

  try {
    const rows = await listPlayerLeaderboardRows(
      supabase,
      leaderboardTable,
      normalizedPlayerId
    );
    const replayPaths = [...new Set(
      rows
        .map((row) => getReplayPathFromRow(row, normalizedPlayerId))
        .filter(Boolean)
    )];
    const obbyIds = [...new Set(
      rows
        .map((row) => String(row?.obby_id ?? "").trim())
        .filter(Boolean)
    )];

    // Storage objects are removed through the Storage API before their database
    // rows so a failed object deletion never creates an orphaned replay file.
    const removedObjectCount = await removeReplayPaths(
      supabase,
      bucketName,
      replayPaths
    );

    const { data: deletedRows, error: deleteError } = await supabase
      .from(leaderboardTable)
      .delete()
      .eq("player_id", normalizedPlayerId)
      .select("id, player_id, obby_id, replay_path");

    if (deleteError) {
      throw deleteError;
    }

    return {
      status: 200,
      body: {
        success: true,
        playerId: normalizedPlayerId,
        obbyIds,
        replayPathCount: replayPaths.length,
        removedObjectCount,
        deletedRowCount: Array.isArray(deletedRows) ? deletedRows.length : 0,
      },
    };
  } catch (error) {
    return {
      status: 500,
      body: {
        success: false,
        playerId: normalizedPlayerId,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

module.exports = {
  getReplayPathFromRow,
  listPlayerLeaderboardRows,
  normalizePlayerId,
  purgePlayerReplayData,
};
