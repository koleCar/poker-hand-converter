import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? "frontend-site";
const distDir = path.resolve(process.env.FRONTEND_DIST_DIR ?? "frontend/dist");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const explicitUrl = process.env.SUPABASE_URL;
const projectRef = process.env.SUPABASE_PROJECT_REF;

if (!serviceRoleKey) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY environment variable.");
}

const supabaseUrl =
  explicitUrl ?? (projectRef ? `https://${projectRef}.supabase.co` : undefined);

if (!supabaseUrl) {
  throw new Error("Set SUPABASE_URL or SUPABASE_PROJECT_REF before deployment.");
}

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
]);

async function listFilesRecursively(rootDir, relativeDir = "") {
  const currentDir = path.join(rootDir, relativeDir);
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryRelativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(rootDir, entryRelativePath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(entryRelativePath);
    }
  }

  return files;
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES.get(extension) ?? "application/octet-stream";
}

async function uploadFile(relativeFilePath) {
  const localPath = path.join(distDir, relativeFilePath);
  const bytes = await readFile(localPath);
  const normalizedObjectPath = relativeFilePath.split(path.sep).join("/");
  const targetUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${normalizedObjectPath}`;
  const contentType = getContentType(relativeFilePath);

  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "x-upsert": "true",
      "content-type": contentType,
    },
    body: bytes,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Upload failed for ${normalizedObjectPath}: ${response.status} ${response.statusText} ${body}`,
    );
  }

  console.log(`Uploaded: ${normalizedObjectPath}`);
}

const files = await listFilesRecursively(distDir);

if (files.length === 0) {
  throw new Error(`No files found in ${distDir}. Run the frontend build first.`);
}

for (const file of files) {
  await uploadFile(file);
}

console.log(
  `Upload complete. ${files.length} file(s) deployed to bucket "${bucket}" on ${supabaseUrl}.`,
);
