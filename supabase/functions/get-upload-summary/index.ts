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

    const { data: uploads, error: uploadsError } = await supabase
      .from("uploads")
      .select("id, filename")
      .eq("upload_batch_id", batchId)
      .eq("owner_id", user.id);

    if (uploadsError) {
      return json({ error: uploadsError.message }, { status: 400 });
    }

    if (!uploads || uploads.length === 0) {
      return json({ id: batchId, files: [] });
    }

    const uploadIds = uploads.map((upload) => upload.id);
    const { data: convertedFiles, error: convertedError } = await supabase
      .from("converted_files")
      .select("upload_id, output_filename, hand_count, warning_count")
      .in("upload_id", uploadIds);

    if (convertedError) {
      return json({ error: convertedError.message }, { status: 400 });
    }

    const fileSummaries = uploads.map((upload) => {
      const converted = convertedFiles?.find((file) => file.upload_id === upload.id);
      return {
        inputFileName: upload.filename,
        outputFileName: converted?.output_filename ?? `${upload.filename}.gg.txt`,
        handCount: converted?.hand_count ?? 0,
        warningCount: converted?.warning_count ?? 0,
        status: converted ? "converted" : "failed",
      };
    });

    return json({
      id: batchId,
      files: fileSummaries,
    });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Unexpected function error" },
      { status: 500 },
    );
  }
});
