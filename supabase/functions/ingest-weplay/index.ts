import { convertWeplayFile } from "../_shared/converter.ts";
import { getSupabaseClient } from "../_shared/supabaseClient.ts";

interface InputFile {
  name: string;
  contentBase64: string;
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function decodeBase64(input: string): string {
  const decoded = atob(input);
  const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
    const files = (body.files ?? []) as InputFile[];
    if (!Array.isArray(files) || files.length === 0) {
      return json({ error: "No files provided" }, { status: 400 });
    }

    const batchId = crypto.randomUUID();
    const reportFiles: Array<{
      inputFileName: string;
      outputFileName: string;
      handCount: number;
      warningCount: number;
      status: "converted" | "failed";
      message?: string;
    }> = [];

    for (const file of files) {
      try {
        const text = decodeBase64(file.contentBase64);
        const converted = convertWeplayFile(file.name, text);

        const { data: uploadRow, error: uploadError } = await supabase
          .from("uploads")
          .insert({
            upload_batch_id: batchId,
            owner_id: user.id,
            source_site: "weplay",
            filename: file.name,
            warnings: converted.warnings,
          })
          .select("id")
          .single();

        if (uploadError || !uploadRow) {
          throw new Error(uploadError?.message ?? "Failed to create upload row");
        }

        const uploadId = uploadRow.id as string;

        const { error: convertedFileError } = await supabase.from("converted_files").insert({
          upload_id: uploadId,
          output_filename: converted.outputFileName,
          gg_text: converted.ggText,
          hand_count: converted.handCount,
          warning_count: converted.warningCount,
        });
        if (convertedFileError) {
          throw new Error(convertedFileError.message);
        }

        for (const hand of converted.hands) {
          const { data: handRow, error: handError } = await supabase
            .from("hands")
            .insert({
              upload_id: uploadId,
              source_hand_id: hand.sourceHandId,
              game_type: hand.gameType,
              table_name: hand.tableName,
              played_at: hand.playedAt,
              raw_hand_text: hand.rawHandText,
              gg_hand_text: hand.ggHandText,
            })
            .select("id")
            .single();

          if (handError || !handRow) {
            throw new Error(handError?.message ?? "Failed to insert hand");
          }

          const handId = handRow.id as string;

          if (hand.players.length > 0) {
            const { error: playersError } = await supabase.from("hand_players").insert(
              hand.players.map((player) => ({
                hand_id: handId,
                player_name: player.playerName,
                seat_no: player.seatNo,
                stack_text: player.stackText,
              })),
            );
            if (playersError) {
              throw new Error(playersError.message);
            }
          }

          if (hand.knownCards.length > 0) {
            const { error: cardsError } = await supabase.from("player_cards").insert(
              hand.knownCards.map((card) => ({
                hand_id: handId,
                player_name: card.playerName,
                card_1: card.card1,
                card_2: card.card2,
                source: card.source,
                is_known: true,
              })),
            );
            if (cardsError) {
              throw new Error(cardsError.message);
            }
          }

          if (hand.actions.length > 0) {
            const { error: actionsError } = await supabase.from("hand_actions").insert(
              hand.actions.map((actionLine) => ({
                hand_id: handId,
                street: null,
                action_line: actionLine,
              })),
            );
            if (actionsError) {
              throw new Error(actionsError.message);
            }
          }
        }

        reportFiles.push({
          inputFileName: file.name,
          outputFileName: converted.outputFileName,
          handCount: converted.handCount,
          warningCount: converted.warningCount,
          status: "converted",
        });
      } catch (error) {
        reportFiles.push({
          inputFileName: file.name,
          outputFileName: `${file.name.replace(/\.txt$/i, "")}.gg.txt`,
          handCount: 0,
          warningCount: 0,
          status: "failed",
          message: error instanceof Error ? error.message : "Unknown conversion error",
        });
      }
    }

    return json({
      id: batchId,
      createdAt: new Date().toISOString(),
      files: reportFiles,
    });
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : "Unexpected function error",
      },
      { status: 500 },
    );
  }
});
