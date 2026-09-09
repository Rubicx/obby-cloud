const test = require("node:test");
const assert = require("node:assert/strict");

const { saveLeaderboardRow } = require("../leaderboardStore");

test("atomically upserts one row per player and obby", async () => {
  const calls = [];
  const expectedError = null;
  const supabase = {
    from(table) {
      calls.push({ method: "from", table });
      return {
        async upsert(row, options) {
          calls.push({ method: "upsert", row, options });
          return { error: expectedError };
        },
      };
    },
  };

  const result = await saveLeaderboardRow(supabase, "leaderboard", {
    userId: 123,
    playerName: "Runner",
    obbyId: "obby-1",
    obbyVersion: 2,
    timeTaken: 4567,
    replayPath: "obby-1/123.json",
    averageFPS: 59.95,
    timeOfCompletion: 1785659103,
    completionData: { AveragePing: 42 },
    hasReplayData: true,
    replayRevision: "rev-1",
    replayDigest: "digest-1",
    submissionId: "submission-1",
  });

  assert.equal(result, expectedError);
  assert.deepEqual(calls[0], { method: "from", table: "leaderboard" });
  assert.equal(calls[1].method, "upsert");
  assert.equal(calls[1].row.player_id, "123");
  assert.equal(calls[1].row.obby_id, "obby-1");
  assert.equal(calls[1].row.obby_version, 2);
  assert.equal(calls[1].row.time_taken, 4567);
  assert.equal(calls[1].row.replay_path, "obby-1/123.json");
  assert.equal(calls[1].row.average_fps, 59.95);
  assert.equal(calls[1].row.time_of_completion, 1785659103);
  assert.deepEqual(calls[1].row.completion_data, { AveragePing: 42 });
  assert.equal(calls[1].row.has_replay_data, true);
  assert.equal(calls[1].row.replay_revision, "rev-1");
  assert.equal(calls[1].row.replay_digest, "digest-1");
  assert.equal(calls[1].row.submission_id, "submission-1");
  assert.equal(typeof calls[1].row.created_at, "string");
  assert.equal(calls[1].row.updated_at, calls[1].row.created_at);
  assert.deepEqual(calls[1].options, {
    onConflict: "player_id,obby_id",
  });
});

test("returns an upsert error to the request handler", async () => {
  const expectedError = new Error("database unavailable");
  const supabase = {
    from() {
      return {
        async upsert() {
          return { error: expectedError };
        },
      };
    },
  };

  const result = await saveLeaderboardRow(supabase, "leaderboard", {
    userId: "1",
    obbyId: "2",
    obbyVersion: 1,
    timeTaken: 3,
    replayPath: "2/1.json",
  });

  assert.equal(result, expectedError);
});
