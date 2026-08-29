const test = require("node:test");
const assert = require("node:assert/strict");

const {
  activateObbyVersion,
  getExpectedObbyVersion,
  normalizeObbyVersion,
} = require("../obbyVersionStore");

test("normalizes positive whole obby versions", () => {
  assert.equal(normalizeObbyVersion(2.9), 2);
  assert.equal(normalizeObbyVersion("3"), 3);
  assert.equal(normalizeObbyVersion(0), null);
  assert.equal(normalizeObbyVersion(undefined), null);
});

test("activates one version epoch per obby", async () => {
  let captured;
  const supabase = {
    from(table) {
      assert.equal(table, "obby_version_epochs");
      return {
        async upsert(row, options) {
          captured = { row, options };
          return { error: null };
        },
      };
    },
  };

  assert.equal(await activateObbyVersion(supabase, "obby-1", 2), 2);
  assert.equal(captured.row.obby_id, "obby-1");
  assert.equal(captured.row.current_version, 2);
  assert.deepEqual(captured.options, { onConflict: "obby_id" });
});

test("reads the current version epoch", async () => {
  const supabase = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          return { data: { current_version: 7 }, error: null };
        },
      };
    },
  };

  assert.equal(await getExpectedObbyVersion(supabase, "obby-1"), 7);
});
