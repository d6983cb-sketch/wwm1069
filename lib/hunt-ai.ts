import type { SupabaseClient } from "@supabase/supabase-js";
import type { HuntAutoCandidate, HuntAutoStatus, HuntEventRecord } from "@/lib/hunt";

export const HUNT_EMBEDDING_MODEL = "gemini-embedding-2";
export const HUNT_EMBEDDING_DIMENSIONS = 768;

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
  if (!best) return { status: "uncertain", targetNumber: null, similarity: null, candidates };
  const confident = best.similarity >= threshold
    && (!second || best.similarity - second.similarity >= margin);
  return {
    status: confident ? "matched" : "uncertain",
    targetNumber: best.targetNumber,
    similarity: best.similarity,
    candidates,
  };
}

export async function embedHuntImage(image: Blob) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("hunt_ai_not_configured");
  if (image.type !== "image/jpeg" && image.type !== "image/png") throw new Error("hunt_ai_unsupported_image");
  const bytes = Buffer.from(await image.arrayBuffer());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${HUNT_EMBEDDING_MODEL}:embedContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        content: { parts: [{ inlineData: { mimeType: image.type, data: bytes.toString("base64") } }] },
        outputDimensionality: HUNT_EMBEDDING_DIMENSIONS,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
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
  return classifyHuntMatches((data ?? []) as MatchRow[], event.auto_match_threshold, event.auto_match_margin);
}
