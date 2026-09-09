async function saveLeaderboardRow(
  supabase,
  leaderboardTable,
  {
    userId,
    playerName,
    obbyId,
    obbyVersion,
    timeTaken,
    replayPath,
    averageFPS,
    timeOfCompletion,
    completionData,
    hasReplayData,
    replayRevision,
    replayDigest,
    submissionId,
  }
) {
  const now = new Date().toISOString();
  const row = {
    player_id: String(userId),
    player_name: playerName || null,
    obby_id: String(obbyId),
    obby_version: Number.isFinite(Number(obbyVersion)) && Number(obbyVersion) >= 1
      ? Math.floor(Number(obbyVersion))
      : null,
    time_taken: Number(timeTaken),
    replay_path: replayPath,
    average_fps: Number.isFinite(Number(averageFPS)) ? Number(averageFPS) : null,
    time_of_completion: Number.isFinite(Number(timeOfCompletion))
      ? Math.floor(Number(timeOfCompletion))
      : null,
    completion_data: completionData && typeof completionData === "object"
      ? completionData
      : {},
    has_replay_data: hasReplayData !== false,
    replay_revision: replayRevision ? String(replayRevision) : null,
    replay_digest: replayDigest ? String(replayDigest) : null,
    submission_id: submissionId ? String(submissionId) : null,
    created_at: now,
    updated_at: now,
  };

  // The database unique constraint makes this one atomic operation. Concurrent
  // saves for the same player/obby can update the row, but cannot duplicate it.
  const { error } = await supabase
    .from(leaderboardTable)
    .upsert(row, { onConflict: "player_id,obby_id" });

  return error;
}

module.exports = {
  saveLeaderboardRow,
};
