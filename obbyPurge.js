const STORAGE_LIST_PAGE_SIZE = 1000;
const STORAGE_REMOVE_BATCH_SIZE = 1000;
const { activateObbyVersion, normalizeObbyVersion } = require("./obbyVersionStore");

function normalizeObbyId(value) {
  const obbyId = String(value ?? "").trim();

  if (!obbyId || obbyId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(obbyId)) {
    return null;
  }

  return obbyId;
}

async function listReplayPathsForObby(supabase, bucketName, obbyId) {
  const paths = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase.storage
      .from(bucketName)
      .list(obbyId, {
        limit: STORAGE_LIST_PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });

    if (error) {
      throw error;
    }

    const objects = Array.isArray(data) ? data : [];
    for (const object of objects) {
      if (object && typeof object.name === "string" && object.name !== "") {
        paths.push(`${obbyId}/${object.name}`);
      }
    }

    if (objects.length < STORAGE_LIST_PAGE_SIZE) {
      break;
    }

    offset += objects.length;
  }

  return paths;
}

async function removeReplayPaths(supabase, bucketName, paths) {
  const removedObjects = [];

  for (let index = 0; index < paths.length; index += STORAGE_REMOVE_BATCH_SIZE) {
    const batch = paths.slice(index, index + STORAGE_REMOVE_BATCH_SIZE);
    const { data, error } = await supabase.storage
      .from(bucketName)
      .remove(batch);

    if (error) {
      throw error;
    }

    if (Array.isArray(data)) {
      removedObjects.push(...data);
    }
  }

  return removedObjects;
}

async function purgeObbyReplayData(
  supabase,
  { bucketName, leaderboardTable, obbyId, replacementVersion }
) {
  const normalizedObbyId = normalizeObbyId(obbyId);
  const normalizedReplacementVersion = normalizeObbyVersion(replacementVersion);
  if (!normalizedObbyId || !normalizedReplacementVersion) {
    return {
      status: 400,
      body: {
        success: false,
        error: !normalizedObbyId ? "Invalid obbyId" : "Invalid replacementVersion",
      },
    };
  }

  try {
    // Activate the new epoch first so still-running old game servers cannot
    // repopulate the leaderboard while the replacement place is unpublished.
    await activateObbyVersion(
      supabase,
      normalizedObbyId,
      normalizedReplacementVersion
    );

    const replayPaths = await listReplayPathsForObby(
      supabase,
      bucketName,
      normalizedObbyId
    );
    const removedObjects = await removeReplayPaths(
      supabase,
      bucketName,
      replayPaths
    );

    const { data: deletedRows, error: deleteError } = await supabase
      .from(leaderboardTable)
      .delete()
      .eq("obby_id", normalizedObbyId)
      .select("id, player_id, obby_id, replay_path");

    if (deleteError) {
      throw deleteError;
    }

    return {
      status: 200,
      body: {
        success: true,
        obbyId: normalizedObbyId,
        replacementVersion: normalizedReplacementVersion,
        replayPathsFound: replayPaths.length,
        removedObjectCount: removedObjects.length,
        deletedRowCount: Array.isArray(deletedRows) ? deletedRows.length : 0,
      },
    };
  } catch (error) {
    return {
      status: 500,
      body: {
        success: false,
        obbyId: normalizedObbyId,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

module.exports = {
  listReplayPathsForObby,
  normalizeObbyId,
  purgeObbyReplayData,
};
