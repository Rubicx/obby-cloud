const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getReplayPathFromRow,
  normalizePlayerId,
  purgePlayerReplayData,
} = require("../playerPurge");

test("validates player ids and replay paths", () => {
  assert.equal(normalizePlayerId(2472617408), "2472617408");
  assert.equal(normalizePlayerId("0"), null);
  assert.equal(normalizePlayerId("12.5"), null);
  assert.equal(getReplayPathFromRow({ replay_path: "obby-a/2.json" }, "2"), "obby-a/2.json");
  assert.equal(getReplayPathFromRow({ obby_id: "obby-a" }, "2"), "obby-a/2.json");
  assert.equal(getReplayPathFromRow({ replay_path: "../secret", obby_id: "obby-a" }, "2"), "obby-a/2.json");
});

test("removes all unique replay objects before deleting player rows", async () => {
  const calls = [];
  const rows = [
    { id: 1, player_id: "2", obby_id: "obby-a", replay_path: "obby-a/2.json" },
    { id: 2, player_id: "2", obby_id: "obby-b", replay_path: null },
    { id: 3, player_id: "2", obby_id: "obby-a", replay_path: "obby-a/2.json" },
  ];

  const supabase = {
    storage: {
      from(bucket) {
        return {
          async remove(paths) {
            calls.push({ method: "remove", bucket, paths });
            return { data: paths.map((name) => ({ name })), error: null };
          },
        };
      },
    },
    from(table) {
      return {
        select(columns) {
          calls.push({ method: "read", table, columns });
          return this;
        },
        delete() {
          calls.push({ method: "delete", table });
          return this;
        },
        eq(column, value) {
          calls.push({ method: "eq", column, value });
          return this;
        },
        order() {
          return this;
        },
        async range() {
          return { data: rows, error: null };
        },
        then(resolve) {
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
    },
  };

  const result = await purgePlayerReplayData(supabase, {
    bucketName: "obby-replays",
    leaderboardTable: "leaderboard",
    playerId: 2,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.obbyIds, ["obby-a", "obby-b"]);
  assert.equal(result.body.replayPathCount, 2);
  assert.deepEqual(calls.find((call) => call.method === "remove").paths, [
    "obby-a/2.json",
    "obby-b/2.json",
  ]);
  assert.ok(calls.find((call) => call.method === "delete"));
});

test("keeps leaderboard rows when storage deletion fails", async () => {
  let deleted = false;
  const supabase = {
    storage: {
      from() {
        return {
          async remove() {
            return { data: null, error: new Error("storage unavailable") };
          },
        };
      },
    },
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        order() { return this; },
        async range() {
          return {
            data: [{ id: 1, player_id: "2", obby_id: "obby-a", replay_path: "obby-a/2.json" }],
            error: null,
          };
        },
        delete() {
          deleted = true;
          return this;
        },
      };
    },
  };

  const result = await purgePlayerReplayData(supabase, {
    bucketName: "obby-replays",
    leaderboardTable: "leaderboard",
    playerId: 2,
  });

  assert.equal(result.status, 500);
  assert.equal(deleted, false);
});
