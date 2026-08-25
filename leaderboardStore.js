async function saveLeaderboardRow(
  supabase,
  leaderboardTable,
  { userId, playerName, obbyId, timeTaken, replayPath }
) {
  const row = {
    player_id: String(userId),
    player_name: playerName || null,
    obby_id: String(obbyId),
    time_taken: Number(timeTaken),
    replay_path: replayPath,
    created_at: new Date().toISOString(),
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
