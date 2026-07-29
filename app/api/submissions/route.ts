import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isSubmissionOpen } from "@/lib/types";
import { DEFAULT_SUBMISSION_IMAGE_CROP, SUBMISSION_IMAGE_ASPECT_VALUE } from "@/lib/types";

const MAX_FILES = 5;
const validPath = (userId: string, value: unknown, kind: "entry" | "original") =>
  typeof value === "string"
  && value.startsWith(`${userId}/`)
  && value.includes(`-${kind}-`)
  && /\.(?:jpe?g|png|webp)$/i.test(value);

async function removeUploads(entryPaths: string[], originalPath: string | null) {
  const admin = createAdminClient();
  if (entryPaths.length) await admin.storage.from("cos-entries").remove(entryPaths);
  if (originalPath) await admin.storage.from("cos-originals").remove([originalPath]);
}

async function removeUnreferencedUploads(entryPaths: string[], originalPath: string | null) {
  const admin = createAdminClient();
  const cleanPaths = entryPaths.filter((path): path is string => typeof path === "string");
  const publicUrls = cleanPaths.map(
    (path) => admin.storage.from("cos-entries").getPublicUrl(path).data.publicUrl,
  );
  const [{ data: usedImages }, { data: usedOriginal }] = await Promise.all([
    publicUrls.length
      ? admin.from("entry_images").select("storage_path").in("storage_path", publicUrls)
      : Promise.resolve({ data: [] }),
    originalPath
      ? admin.from("entries").select("original_image_path").eq("original_image_path", originalPath)
      : Promise.resolve({ data: [] }),
  ]);
  const referencedUrls = new Set((usedImages ?? []).map((image) => image.storage_path));
  const removableEntryPaths = cleanPaths.filter(
    (_path, index) => !referencedUrls.has(publicUrls[index]),
  );
  await removeUploads(removableEntryPaths, usedOriginal?.length ? null : originalPath);
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const entryPaths = Array.isArray(body.imagePaths) ? [...new Set(body.imagePaths)] : [];
  const usesAiBackground = body.usesAiBackground === true;
  const originalPath = usesAiBackground && typeof body.originalPath === "string"
    ? body.originalPath
    : null;
  const characterName = String(body.characterName ?? "").trim();
  const sourceGame = String(body.sourceGame ?? "").trim();
  const description = String(body.description ?? "").trim();
  const imageCrops = Array.isArray(body.imageCrops) ? body.imageCrops : [];
  const normalizedCrops = entryPaths.map((_, index) => {
    const crop = imageCrops[index] && typeof imageCrops[index] === "object" ? imageCrops[index] : {};
    const value = crop as Record<string, unknown>;
    const clamp = (input: unknown, minimum: number, maximum: number, fallback: number) => {
      const number = Number(input);
      return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
    };
    return {
      crop_x: clamp(value.crop_x, -50, 50, DEFAULT_SUBMISSION_IMAGE_CROP.crop_x),
      crop_y: clamp(value.crop_y, -50, 50, DEFAULT_SUBMISSION_IMAGE_CROP.crop_y),
      zoom: clamp(value.zoom, 1, 3, DEFAULT_SUBMISSION_IMAGE_CROP.zoom),
      rotation: clamp(value.rotation, -180, 180, DEFAULT_SUBMISSION_IMAGE_CROP.rotation),
      aspect_ratio: SUBMISSION_IMAGE_ASPECT_VALUE,
    };
  });

  const invalid =
    entryPaths.length < 1
    || entryPaths.length > MAX_FILES
    || entryPaths.some((path) => !validPath(user.id, path, "entry"))
    || (usesAiBackground && !validPath(user.id, originalPath, "original"))
    || !characterName
    || characterName.length > 40
    || !sourceGame
    || sourceGame.length > 40
    || description.length > 500;
  if (invalid) {
    await removeUnreferencedUploads(entryPaths.filter((path): path is string => typeof path === "string"), originalPath);
    return NextResponse.json({ error: "invalid_submission" }, { status: 400 });
  }

  const [{ data: event }, { data: profile }] = await Promise.all([
    admin.from("events").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("profiles").select("is_disqualified").eq("id", user.id).maybeSingle(),
  ]);
  if (!event || !isSubmissionOpen(event) || profile?.is_disqualified) {
    await removeUnreferencedUploads(entryPaths as string[], originalPath);
    return NextResponse.json({ error: "submissions_closed" }, { status: 400 });
  }

  const { data: existing } = await admin
    .from("entries")
    .select("id")
    .eq("event_id", event.id)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (existing) {
    await removeUnreferencedUploads(entryPaths as string[], originalPath);
    return NextResponse.json({ error: "duplicate_entry" }, { status: 409 });
  }

  const publicUrls = (entryPaths as string[]).map(
    (path) => admin.storage.from("cos-entries").getPublicUrl(path).data.publicUrl,
  );
  const { data: entry, error: entryError } = await admin
    .from("entries")
    .insert({
      event_id: event.id,
      owner_id: user.id,
      character_name: characterName,
      source_game: sourceGame,
      description: description || null,
      uses_ai_background: usesAiBackground,
      original_image_path: originalPath,
      status: "approved",
    })
    .select("id")
    .single();

  if (entryError || !entry) {
    await removeUnreferencedUploads(entryPaths as string[], originalPath);
    const error = entryError?.code === "23505" ? "duplicate_entry" : "entry_create_failed";
    return NextResponse.json({ error }, { status: error === "duplicate_entry" ? 409 : 400 });
  }

  const { error: imageError } = await admin.from("entry_images").insert(
    publicUrls.map((storage_path, index) => ({
      entry_id: entry.id,
      storage_path,
      position: index + 1,
      ...normalizedCrops[index],
    })),
  );
  if (imageError) {
    await admin.from("entries").delete().eq("id", entry.id);
    await removeUnreferencedUploads(entryPaths as string[], originalPath);
    return NextResponse.json({ error: "image_records_failed" }, { status: 400 });
  }

  return NextResponse.json({ ok: true, entryId: entry.id });
}

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json();
  const entryPaths = Array.isArray(body.imagePaths)
    ? body.imagePaths.filter((path: unknown) => validPath(user.id, path, "entry"))
    : [];
  const originalPath = validPath(user.id, body.originalPath, "original")
    ? body.originalPath as string
    : null;
  await removeUnreferencedUploads(entryPaths, originalPath);
  return NextResponse.json({ ok: true });
}
