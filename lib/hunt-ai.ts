import type { SupabaseClient } from "@supabase/supabase-js";
import type { HuntAutoCandidate, HuntAutoStatus, HuntAutoVerification, HuntEventRecord } from "@/lib/hunt";

export const HUNT_EMBEDDING_MODEL = "gemini-embedding-2";
// Use the current stable multimodal Flash model for strict local-scene verification.
// The older 2.5 endpoint returns 404 for this production API key even though the
// embedding endpoint remains available.
export const HUNT_VERIFICATION_MODEL = "gemini-3.5-flash";
export const HUNT_AI_PIPELINE_MODEL = `${HUNT_EMBEDDING_MODEL}+${HUNT_VERIFICATION_MODEL}`;
export const HUNT_EMBEDDING_DIMENSIONS = 768;
export const HUNT_AI_MAX_429_RETRIES = 3;
export const HUNT_VISION_CONFIDENCE_THRESHOLD = 0.9;

const HUNT_AI_RETRY_BASE_MS = 1_000;
const HUNT_AI_RETRY_MAX_MS = 8_000;
const HUNT_AI_QUEUE_MAX_WAIT_MS = 25_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type RetryDependencies = {
  fetcher?: FetchLike;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
};

let huntAiQueueTail: Promise<void> = Promise.resolve();

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMilliseconds(value: string | null, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

export async function fetchHuntAiWith429Retry(
  input: string | URL | Request,
  init: RequestInit,
  dependencies: RetryDependencies = {},
) {
  const fetcher = dependencies.fetcher ?? fetch;
  const sleep = dependencies.sleep ?? wait;
  const random = dependencies.random ?? Math.random;

  for (let retry = 0; ; retry += 1) {
    const response = await fetcher(input, init);
    if (response.status !== 429 || retry >= HUNT_AI_MAX_429_RETRIES) return response;

    const exponentialDelay = HUNT_AI_RETRY_BASE_MS * (2 ** retry);
    const serverDelay = retryAfterMilliseconds(response.headers.get("retry-after")) ?? 0;
    const jitter = Math.floor(random() * 250);
    await sleep(Math.min(HUNT_AI_RETRY_MAX_MS, Math.max(exponentialDelay, serverDelay) + jitter));
  }
}

export async function withHuntAiQueue<T>(task: () => Promise<T>) {
  let release = () => {};
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = huntAiQueueTail;
  huntAiQueueTail = previous.then(() => turn, () => turn);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("hunt_ai_queue_timeout")), HUNT_AI_QUEUE_MAX_WAIT_MS);
      }),
    ]);
    return await task();
  } finally {
    if (timeout) clearTimeout(timeout);
    release();
  }
}

type MatchRow = {
  reference_image_id: string;
  reference_point_id: string;
  target_number: number;
  similarity: number;
};

export type HuntMatchDecision = {
  status: Extract<HuntAutoStatus, "matched" | "uncertain">;
  targetNumber: number | null;
  similarity: number | null;
  candidates: HuntAutoCandidate[];
  verification: HuntAutoVerification | null;
};

export function isHuntAiConfigured() {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

export function classifyHuntMatches(
  rows: Array<Pick<MatchRow, "target_number" | "similarity">>,
  threshold: number,
  margin: number,
): HuntMatchDecision {
  const bestByTarget = new Map<number, number>();
  for (const row of rows) {
    if (!Number.isInteger(row.target_number) || !Number.isFinite(row.similarity)) continue;
    const previous = bestByTarget.get(row.target_number);
    if (previous == null || row.similarity > previous) bestByTarget.set(row.target_number, row.similarity);
  }
  const candidates = [...bestByTarget.entries()]
    .map(([targetNumber, similarity]) => ({ targetNumber, similarity }))
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, 3);
  const best = candidates[0];
  const second = candidates[1];
  if (!best) return { status: "uncertain", targetNumber: null, similarity: null, candidates, verification: null };
  const confident = best.similarity >= threshold
    && (!second || best.similarity - second.similarity >= margin);
  return {
    status: confident ? "matched" : "uncertain",
    targetNumber: best.targetNumber,
    similarity: best.similarity,
    candidates,
    verification: null,
  };
}

export function finalizeHuntVisionDecision(
  candidates: HuntAutoCandidate[],
  verification: HuntAutoVerification,
): HuntMatchDecision {
  const selected = candidates.find((candidate) => candidate.targetNumber === verification.matchedTargetNumber);
  const accepted = Boolean(selected)
    && verification.objectVisible
    && verification.samePhysicalLocation
    && verification.confidence >= HUNT_VISION_CONFIDENCE_THRESHOLD;
  return {
    status: accepted ? "matched" : "uncertain",
    targetNumber: accepted ? verification.matchedTargetNumber : null,
    similarity: accepted ? selected!.similarity : candidates[0]?.similarity ?? null,
    candidates,
    verification,
  };
}

function normalizeVerification(value: unknown, allowedTargets: number[]): HuntAutoVerification {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const matchedTargetNumber = Number(row.matchedTargetNumber);
  const confidence = Math.max(0, Math.min(1, Number(row.confidence) || 0));
  return {
    matchedTargetNumber: allowedTargets.includes(matchedTargetNumber) ? matchedTargetNumber : 0,
    objectVisible: row.objectVisible === true,
    samePhysicalLocation: row.samePhysicalLocation === true,
    confidence,
    reason: String(row.reason ?? "視覺模型未提供判定理由。").trim().slice(0, 500),
  };
}

type ReferenceForVerification = {
  targetNumber: number;
  label: string | null;
  image: Blob;
};

async function blobInlineData(image: Blob) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(image.type)) throw new Error("hunt_ai_unsupported_image");
  return {
    inlineData: {
      mimeType: image.type,
      data: Buffer.from(await image.arrayBuffer()).toString("base64"),
    },
  };
}

export async function verifyHuntCandidateImages(
  proof: Blob,
  references: ReferenceForVerification[],
  allowedTargets: number[],
) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("hunt_ai_not_configured");
  if (!references.length || !allowedTargets.length) throw new Error("hunt_ai_missing_references");

  const parts: Array<{ text: string } | Awaited<ReturnType<typeof blobInlineData>>> = [
    { text: `你是嚴格的遊戲尋物照片核對器。第一張圖片是玩家上傳照片，後面是候選點位的參考照片。\n\n判定規則：\n1. 必須在玩家照片中實際看見參考圖所示的同一個小型藏物標記，並且周圍固定建築、牆面、屋簷、樹木或地形的相對位置一致。\n2. 相同遊戲、角色、介面 HUD、色調、天氣或相似建築風格都不能當成命中證據。\n3. 小物件若太小、模糊、被完全遮住，或只能確認場景相似，matchedTargetNumber 必須回傳 0。\n4. 可接受視角、距離、時間與部分遮擋不同，但可見線索必須足以確認同一實體點位。\n5. 只能從候選編號 ${allowedTargets.join(", ")} 中選一個；都不符合時選 0。\n6. 信心不足 0.90 時選 0。\n\n請用繁體中文簡短說明理由。` },
    { text: "玩家上傳照片：" },
    await blobInlineData(proof),
  ];
  for (const reference of references) {
    parts.push({ text: `候選 H${String(reference.targetNumber).padStart(3, "0")}${reference.label ? `（${reference.label}）` : ""} 參考照片：` });
    parts.push(await blobInlineData(reference.image));
  }

  return withHuntAiQueue(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35_000);
    try {
      const response = await fetchHuntAiWith429Retry(
        `https://generativelanguage.googleapis.com/v1beta/models/${HUNT_VERIFICATION_MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents: [{ role: "user", parts }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 300,
              responseMimeType: "application/json",
              responseSchema: {
                type: "OBJECT",
                properties: {
                  matchedTargetNumber: { type: "INTEGER" },
                  objectVisible: { type: "BOOLEAN" },
                  samePhysicalLocation: { type: "BOOLEAN" },
                  confidence: { type: "NUMBER" },
                  reason: { type: "STRING" },
                },
                required: ["matchedTargetNumber", "objectVisible", "samePhysicalLocation", "confidence", "reason"],
              },
            },
          }),
          signal: controller.signal,
          cache: "no-store",
        },
      );
      if (!response.ok) throw new Error(`hunt_ai_verification_http_${response.status}`);
      const body = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
      if (!text) throw new Error("hunt_ai_invalid_verification");
      return normalizeVerification(JSON.parse(text), allowedTargets);
    } finally {
      clearTimeout(timer);
    }
  });
}

export async function embedHuntImage(image: Blob) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("hunt_ai_not_configured");
  if (image.type !== "image/jpeg" && image.type !== "image/png") throw new Error("hunt_ai_unsupported_image");
  const bytes = Buffer.from(await image.arrayBuffer());
  return withHuntAiQueue(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await fetchHuntAiWith429Retry(
        `https://generativelanguage.googleapis.com/v1beta/models/${HUNT_EMBEDDING_MODEL}:embedContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            content: { parts: [{ inlineData: { mimeType: image.type, data: bytes.toString("base64") } }] },
            outputDimensionality: HUNT_EMBEDDING_DIMENSIONS,
          }),
          signal: controller.signal,
          cache: "no-store",
        },
      );
      if (!response.ok) throw new Error(`hunt_ai_http_${response.status}`);
      const body = await response.json() as {
        embedding?: { values?: number[] };
        embeddings?: Array<{ values?: number[] }>;
      };
      const values = body.embedding?.values ?? body.embeddings?.[0]?.values;
      if (!Array.isArray(values) || values.length !== HUNT_EMBEDDING_DIMENSIONS || values.some((value) => !Number.isFinite(value))) {
        throw new Error("hunt_ai_invalid_embedding");
      }
      return values;
    } finally {
      clearTimeout(timer);
    }
  });
}

export async function recognizeHuntImage(
  admin: SupabaseClient,
  event: HuntEventRecord,
  image: Blob,
) {
  const embedding = await embedHuntImage(image);
  const { data, error } = await admin.rpc("match_hunt_reference_images", {
    query_embedding: embedding,
    target_event: event.id,
    match_count: 12,
  });
  if (error) throw new Error(`hunt_ai_match_failed:${error.code ?? "unknown"}`);
  const retrieval = classifyHuntMatches((data ?? []) as MatchRow[], event.auto_match_threshold, event.auto_match_margin);
  const best = retrieval.candidates[0];
  if (!best || best.similarity < event.auto_match_threshold) {
    return { ...retrieval, status: "uncertain" as const, targetNumber: null };
  }

  const allowedTargets = retrieval.candidates.map((candidate) => candidate.targetNumber);
  const { data: points, error: pointsError } = await admin
    .from("hunt_reference_points")
    .select("id,target_number,label")
    .eq("hunt_event_id", event.id)
    .eq("is_active", true)
    .in("target_number", allowedTargets);
  if (pointsError) throw new Error(`hunt_ai_reference_points_failed:${pointsError.code ?? "unknown"}`);
  const pointIds = (points ?? []).map((point) => point.id);
  if (!pointIds.length) return { ...retrieval, status: "uncertain" as const, targetNumber: null };
  const { data: referenceRows, error: referencesError } = await admin
    .from("hunt_reference_images")
    .select("id,reference_point_id,image_path,mime_type,created_at")
    .in("reference_point_id", pointIds)
    .eq("is_active", true)
    .order("created_at", { ascending: true });
  if (referencesError) throw new Error(`hunt_ai_references_failed:${referencesError.code ?? "unknown"}`);

  const selectedRows = allowedTargets.flatMap((targetNumber, targetIndex) => {
    const point = (points ?? []).find((row) => row.target_number === targetNumber);
    if (!point) return [];
    return (referenceRows ?? [])
      .filter((row) => row.reference_point_id === point.id)
      .slice(0, targetIndex === 0 ? 5 : 2)
      .map((row) => ({ ...row, targetNumber, label: point.label as string | null }));
  });
  const references = (await Promise.all(selectedRows.map(async (row) => {
    const { data: reference, error: downloadError } = await admin.storage.from("hunt-references").download(row.image_path);
    if (downloadError || !reference) return null;
    return { targetNumber: row.targetNumber, label: row.label, image: reference };
  }))).filter((row): row is ReferenceForVerification => row !== null);
  if (!references.length) return { ...retrieval, status: "uncertain" as const, targetNumber: null };

  const verification = await verifyHuntCandidateImages(image, references, allowedTargets);
  return finalizeHuntVisionDecision(retrieval.candidates, verification);
}
