import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { nickname } = await request.json();
  const clean = String(nickname ?? "").normalize("NFKC").trim();
  if (!clean || clean.length > 20) return NextResponse.json({ error: "invalid_nickname" }, { status: 400 });
  const discordIdentity = user.identities?.find((identity) => identity.provider === "discord");
  const discordId =
    discordIdentity?.id ??
    discordIdentity?.identity_data?.provider_id ??
    user.user_metadata?.provider_id ??
    user.user_metadata?.sub ??
    user.id;
  const adminIds = (process.env.ADMIN_DISCORD_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const admin = createAdminClient();
  const { data: duplicate } = await admin
    .from("profiles")
    .select("id")
    .ilike("nickname", clean)
    .maybeSingle();
  if (duplicate) return NextResponse.json({ error: "nickname_taken" }, { status: 409 });
  const { error } = await admin.from("profiles").insert({
    id: user.id,
    discord_id: String(discordId),
    nickname: clean,
    is_admin: adminIds.includes(String(discordId)),
  });
  if (error?.code === "23505") return NextResponse.json({ error: "nickname_taken" }, { status: 409 });
  if (error) return NextResponse.json({ error: "profile_failed" }, { status: 400 });
  return NextResponse.json({ ok: true });
}
