import { getSupabaseClient } from "../_shared/supabaseClient.ts";

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const supabase = getSupabaseClient(request);
    const { data: authData } = await supabase.auth.getUser();
    const user = authData.user;
    if (!user) {
      return json({ error: "Authentication required" }, { status: 401 });
    }

    const body = await request.json();
    const batchId = body.batchId as string | undefined;
    if (!batchId) {
      return json({ error: "batchId is required" }, { status: 400 });
    }

    const { data: ownedUploads, error: ownedUploadsError } = await supabase
      .from("uploads")
      .select("id")
      .eq("upload_batch_id", batchId)
      .eq("owner_id", user.id)
      .limit(1);
    if (ownedUploadsError) {
      return json({ error: ownedUploadsError.message }, { status: 400 });
    }
    if (!ownedUploads || ownedUploads.length === 0) {
      return json({ error: "Batch not found." }, { status: 404 });
    }

    const { data: allPlayers, error: allPlayersError } = await supabase
      .from("upload_all_players")
      .select("player_name")
      .eq("upload_batch_id", batchId);
    if (allPlayersError) {
      return json({ error: allPlayersError.message }, { status: 400 });
    }

    const { data: knownPlayers, error: knownPlayersError } = await supabase
      .from("upload_known_cards_players")
      .select("player_name")
      .eq("upload_batch_id", batchId);
    if (knownPlayersError) {
      return json({ error: knownPlayersError.message }, { status: 400 });
    }

    return json({
      batchId,
      all_players: [...new Set((allPlayers ?? []).map((row) => row.player_name))].sort(),
      known_cards_players: [...new Set((knownPlayers ?? []).map((row) => row.player_name))].sort(),
    });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Unexpected function error" },
      { status: 500 },
    );
  }
});
