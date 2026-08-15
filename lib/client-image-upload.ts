const MAX_SOURCE_FILE_BYTES = 30 * 1024 * 1024;
const TARGET_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2560;
const UPLOAD_TIMEOUT_MS = 90_000;
const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

type LoadedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
};

async function loadImage(file: File): Promise<LoadedImage> {
  if ("createImageBitmap" in window) {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      close: () => bitmap.close(),
    };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const next = new Image();
      next.onload = () => resolve(next);
      next.onerror = () => reject(new Error("image_decode_failed"));
      next.src = url;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("image_compression_failed"))),
      type,
      quality,
    );
  });
}

export function validateReplacementPhoto(file: File) {
  if (!allowedTypes.has(file.type)) return "照片只支援 JPG、PNG 或 WEBP。";
  if (file.size > MAX_SOURCE_FILE_BYTES) return "照片不可超過 30 MB。";
  return "";
}

export async function compressReplacementPhoto(file: File, preferredType: "image/webp" | "image/jpeg" = "image/webp") {
  const loaded = await loadImage(file);
  try {
    let scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(loaded.width, loaded.height));
    let quality = 0.88;
    let result: Blob | null = null;
    let outputType = preferredType;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(loaded.width * scale));
      canvas.height = Math.max(1, Math.round(loaded.height * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("canvas_unavailable");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(loaded.source, 0, 0, canvas.width, canvas.height);
      try {
        result = await canvasToBlob(canvas, outputType, quality);
      } catch {
        outputType = "image/jpeg";
        result = await canvasToBlob(canvas, outputType, quality);
      }
      canvas.width = 1;
      canvas.height = 1;
      if (result.size <= TARGET_FILE_BYTES) break;
      if (quality > 0.68) quality -= 0.07;
      else scale *= 0.86;
    }
    if (!result) throw new Error("image_compression_failed");
    const extension = outputType === "image/webp" ? "webp" : "jpg";
    const baseName = file.name.replace(/\.[^.]+$/, "") || "photo";
    return new File([result], `${baseName}.${extension}`, {
      type: outputType,
      lastModified: file.lastModified,
    });
  } finally {
    loaded.close?.();
  }
}

export async function withUploadTimeout<T>(request: Promise<T>, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), UPLOAD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function replacementFileExtension(file: File) {
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpg";
}

export function replacementUploadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/timeout|逾時/i.test(message)) return "上傳時間過久，請確認網路後再試一次。";
  if (/decode|compression|canvas/i.test(message)) return "照片無法處理，請換成 JPG、PNG 或 WEBP 後再試。";
  if (/row-level security|unauthorized|jwt/i.test(message)) return "修正權限或登入狀態已失效，請重新整理後再試。";
  if (/grant_unavailable/i.test(message)) return "修正權限已到期或被管理員撤銷。";
  return "照片修正失敗，原作品仍保持不變。";
}
