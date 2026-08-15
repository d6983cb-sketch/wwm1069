import type { SupabaseClient } from "@supabase/supabase-js";
import type { HuntAutoCandidate, HuntAutoStatus, HuntEventRecord } from "@/lib/hunt";

export const HUNT_EMBEDDING_MODEL = "gemini-embedding-2";
export const HUNT_EMBEDDING_DIMENSIONS = 768;
export const HUNT_AI_MAX_429_RETRIES = 3;

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
  return classifyHuntMatches((data ?? []) as MatchRow[], event.auto_match_threshold, event.auto_match_margin);
}
