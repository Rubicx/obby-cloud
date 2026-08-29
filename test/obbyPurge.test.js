const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeObbyId,
  purgeObbyReplayData,
} = require("../obbyPurge");

test("rejects unsafe obby identifiers", () => {
  assert.equal(normalizeObbyId("obby-123_OK"), "obby-123_OK");
  assert.equal(normalizeObbyId("../other-folder"), null);
  assert.equal(normalizeObbyId(""), null);
});

test("removes every replay object before deleting leaderboard rows", async () => {
  const calls = [];
  const pages = [
    [{ name: "1.json" }, { name: "2.json" }],
  ];
  const supabase = {
    storage: {
      from(bucket) {
        return {
          async list(prefix, options) {
            calls.push({ method: "list", bucket, prefix, options });
            return { data: pages.shift() || [], error: null };
          },
          async remove(paths) {
            calls.push({ method: "remove", bucket, paths });
            return { data: paths.map((name) => ({ name })), error: null };
          },
        };
      },
    },
    from(table) {
      if (table === "obby_version_epochs") {
        return {
          async upsert(row, options) {
            calls.push({ method: "version-upsert", table, row, options });
            return { error: null };
          },
        };
      }
      return {
        delete() {
          calls.push({ method: "delete", table });
          return this;
        },
        eq(column, value) {
          calls.push({ method: "eq", column, value });
          return this;
        },
        async select(columns) {
          calls.push({ method: "select", columns });
          return {
            data: [{ id: 1 }, { id: 2 }],
            error: null,
          };
        },
      };
    },
  };

  const result = await purgeObbyReplayData(supabase, {
    bucketName: "obby-replays",
    leaderboardTable: "leaderboard",
    obbyId: "obby-123",
    replacementVersion: 2,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.replayPathsFound, 2);
  assert.equal(result.body.removedObjectCount, 2);
  assert.equal(result.body.deletedRowCount, 2);
  assert.equal(calls[0].method, "version-upsert");
  assert.deepEqual(calls[2].paths, [
    "obby-123/1.json",
    "obby-123/2.json",
  ]);
  assert.equal(calls[3].method, "delete");
});

test("does not delete leaderboard rows when object removal fails", async () => {
  let leaderboardTouched = false;
  const supabase = {
    storage: {
      from() {
        return {
          async list() {
            return { data: [{ name: "1.json" }], error: null };
          },
          async remove() {
            return { data: null, error: new Error("storage unavailable") };
          },
        };
      },
    },
    from(table) {
      if (table === "obby_version_epochs") {
        return {
          async upsert() {
            return { error: null };
          },
        };
      }
      leaderboardTouched = true;
      throw new Error("leaderboard should not be reached");
    },
  };

  const result = await purgeObbyReplayData(supabase, {
    bucketName: "obby-replays",
    leaderboardTable: "leaderboard",
    obbyId: "obby-123",
    replacementVersion: 2,
  });

  assert.equal(result.status, 500);
  assert.equal(leaderboardTouched, false);
});
