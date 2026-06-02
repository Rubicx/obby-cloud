const express = require("express");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "10mb" }));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.post("/save-replay", async (req, res) => {
  try {
    const { userId, playerName, obbyId, timeTaken, replayData } = req.body;

    if (!userId || !obbyId || timeTaken === undefined || replayData === undefined || replayData === null) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const filePath = `${obbyId}/${userId}.json`;

    const { error: uploadError } = await supabase.storage
      .from("obby-replays")
      .upload(filePath, JSON.stringify(replayData), {
        contentType: "application/json",
        upsert: true,
    });

    if (uploadError) {
      return res.status(500).json({ error: uploadError.message });
    }

    const { error: dbError } = await supabase
      .from("leaderboard")
      .insert({
        player_id: String(userId),
        player_name: playerName || null,
        obby_id: String(obbyId),
        time_taken: Number(timeTaken),
        replay_path: filePath,
      });

    if (dbError) {
      return res.status(500).json({ error: dbError.message });
    }

    res.json({ success: true, replayPath: filePath });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/leaderboard/:obbyId", async (req, res) => {
  const { obbyId } = req.params;

  const { data, error } = await supabase
    .from("leaderboard")
    .select("id, player_id, player_name, obby_id, time_taken, replay_path, created_at")
    .eq("obby_id", obbyId)
    .order("time_taken", { ascending: true })
    .limit(50);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
