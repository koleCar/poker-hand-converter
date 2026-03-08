import JSZip from "npm:jszip@3.10.1";
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
      .select("id")
      .eq("upload_batch_id", batchId)
      .eq("owner_id", user.id);
    if (uploadsError) {
      return json({ error: uploadsError.message }, { status: 400 });
    }
    if (!uploads || uploads.length === 0) {
      return json({ error: "Batch not found." }, { status: 404 });
    }

    const uploadIds = uploads.map((upload) => upload.id);
    const { data: convertedFiles, error: convertedError } = await supabase
      .from("converted_files")
      .select("output_filename, gg_text, hand_count, warning_count")
      .in("upload_id", uploadIds);
    if (convertedError) {
      return json({ error: convertedError.message }, { status: 400 });
    }

    const zip = new JSZip();
    for (const file of convertedFiles ?? []) {
      zip.file(file.output_filename, file.gg_text);
    }

    zip.file(
      "report.json",
      JSON.stringify(
        {
          batchId,
          createdAt: new Date().toISOString(),
          files: (convertedFiles ?? []).map((file) => ({
            outputFileName: file.output_filename,
            handCount: file.hand_count,
            warningCount: file.warning_count,
          })),
        },
        null,
        2,
      ),
    );

    const zipBase64 = await zip.generateAsync({ type: "base64" });
    return json({
      batchId,
      filename: `converted-${batchId}.zip`,
      zipBase64,
    });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "Unexpected function error" },
      { status: 500 },
    );
  }
});
