import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: profile } = await admin.from("profiles").select("is_admin").eq("id", user.id).single();
  if (!profile?.is_admin) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { data: entry } = await admin.from("entries").select("original_image_path").eq("id", Number(id)).single();
  if (!entry?.original_image_path) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { data, error } = await admin.storage.from("cos-originals").createSignedUrl(entry.original_image_path, 60);
  if (error || !data) return NextResponse.json({ error: "signed_url_failed" }, { status: 400 });
  return NextResponse.redirect(data.signedUrl);
}
