const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const BACKEND_URL = String(
  process.env.BACKEND_URL || "https://obby-cloud.onrender.com"
).replace(/\/$/, "");
const OBBY_IDS_FILE = process.env.OBBY_IDS_FILE || "";
const CONCURRENCY = Math.min(
  Math.max(Number.parseInt(process.env.CONCURRENCY || "6", 10) || 6, 1),
  20
);

if (!OBBY_IDS_FILE && (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY)) {
  throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required");
}

async function listLeaderboardKeys() {
  if (OBBY_IDS_FILE) {
    const { readFile } = require("node:fs/promises");
    const obbyIds = JSON.parse(await readFile(OBBY_IDS_FILE, "utf8"));
    if (!Array.isArray(obbyIds)) {
      throw new Error("OBBY_IDS_FILE must contain a JSON array");
    }

    const rows = [];
    let cursor = 0;
    async function worker() {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= obbyIds.length) {
          return;
        }

        const obbyId = String(obbyIds[index]);
        const response = await fetch(
          `${BACKEND_URL}/leaderboard/${encodeURIComponent(obbyId)}?limit=100`
        );
        if (!response.ok) {
          throw new Error(`leaderboard ${obbyId} failed: ${response.status}`);
        }
        const payload = await response.json();
        for (const row of payload.rows || []) {
          rows.push({ obby_id: row.obby_id, player_id: row.player_id });
        }

        const completed = Math.min(cursor, obbyIds.length);
        if (completed % 50 === 0 || completed === obbyIds.length) {
          console.log(`Listed ${completed}/${obbyIds.length} obbies (${rows.length} rows)`);
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return rows;
  }

  const rows = [];

  for (let offset = 0; ; offset += 1000) {
    const url = new URL(`${SUPABASE_URL}/rest/v1/leaderboard`);
    url.searchParams.set("select", "obby_id,player_id");
    url.searchParams.set("order", "id.asc");
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", "1000");

    const response = await fetch(url, {
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      },
    });
    if (!response.ok) {
      throw new Error(`leaderboard page ${offset} failed: ${response.status} ${await response.text()}`);
    }

    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) {
      return rows;
    }
  }
}

async function backfillRow(row) {
  const url = new URL(`${BACKEND_URL}/load-replay`);
  url.searchParams.set("userId", row.player_id);
  url.searchParams.set("obbyId", row.obby_id);

  const response = await fetch(url);
  if (response.ok) {
    // Drain the response so the connection can be reused. The backend performs
    // the metadata repair after assembling this response.
    await response.arrayBuffer();
    return "updated";
  }

  await response.arrayBuffer();
  return response.status === 404 ? "missing" : "failed";
}

async function main() {
  const rows = await listLeaderboardKeys();
  const counts = { updated: 0, missing: 0, failed: 0 };
  let cursor = 0;

  console.log(`Backfilling ${rows.length} leaderboard rows with concurrency ${CONCURRENCY}`);

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= rows.length) {
        return;
      }

      let result = "failed";
      try {
        result = await backfillRow(rows[index]);
      } catch (error) {
        console.warn(`Row ${index + 1} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      counts[result] += 1;

      const completed = counts.updated + counts.missing + counts.failed;
      if (completed % 100 === 0 || completed === rows.length) {
        console.log(`${completed}/${rows.length}`, counts);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log("Backfill complete", counts);

  if (counts.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
