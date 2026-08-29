const VERSION_TABLE = "obby_version_epochs";

function normalizeObbyVersion(value) {
  const version = Number(value);
  if (!Number.isFinite(version) || version < 1) {
    return null;
  }
  return Math.floor(version);
}

async function getExpectedObbyVersion(supabase, obbyId) {
  const { data, error } = await supabase
    .from(VERSION_TABLE)
    .select("current_version")
    .eq("obby_id", String(obbyId))
    .maybeSingle();

  if (error) {
    throw error;
  }

  return normalizeObbyVersion(data?.current_version);
}

async function activateObbyVersion(supabase, obbyId, version) {
  const normalizedVersion = normalizeObbyVersion(version);
  if (!normalizedVersion) {
    throw new Error("Invalid replacementVersion");
  }

  const { error } = await supabase
    .from(VERSION_TABLE)
    .upsert(
      {
        obby_id: String(obbyId),
        current_version: normalizedVersion,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "obby_id" }
    );

  if (error) {
    throw error;
  }

  return normalizedVersion;
}

module.exports = {
  activateObbyVersion,
  getExpectedObbyVersion,
  normalizeObbyVersion,
};
