/**
 * A screenshot made ready to send with a feedback report: read as a data URL
 * (the app's CSP allows `data:` images, not `blob:`), and re-encoded as JPEG
 * when it is too large or in a type the `feedback` function refuses (HEIC,
 * BMP…). The function takes 3 MB per image; anything kept as it is stays
 * under `KEEP_BYTES`, so the limit is never met by a file we chose to keep.
 */

const SENDABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const KEEP_BYTES = 2.5 * 1024 * 1024;
const LIMIT_BYTES = 3 * 1024 * 1024;
const MAX_SIDE = 2560;

export type PrepareError = "imageType" | "imageRead";

/** The decoded size of a data URL's payload. */
export function dataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function readDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("read")));
    reader.onerror = () => reject(reader.error ?? new Error("read"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("decode"));
    image.src = src;
  });
}

function encode(image: HTMLImageElement, maxSide: number, quality: number): string | null {
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  // JPEG has no alpha: a transparent screenshot goes on white, not black.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

/** The image as a data URL the `feedback` function accepts, or why not. */
export async function prepareImage(file: Blob): Promise<string | PrepareError> {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
    return "imageType";
  }
  let original: string;
  let image: HTMLImageElement;
  try {
    original = await readDataUrl(file);
    image = await loadImage(original);
  } catch {
    return "imageRead";
  }
  const small = Math.max(image.naturalWidth, image.naturalHeight) <= MAX_SIDE;
  if (SENDABLE.has(file.type) && file.size <= KEEP_BYTES && small) {
    return original;
  }
  for (const [side, quality] of [
    [MAX_SIDE, 0.85],
    [MAX_SIDE, 0.7],
    [1920, 0.7],
    [1280, 0.6],
  ] as const) {
    const encoded = encode(image, side, quality);
    if (!encoded) return "imageRead";
    if (dataUrlBytes(encoded) <= LIMIT_BYTES) return encoded;
  }
  return "imageRead";
}
