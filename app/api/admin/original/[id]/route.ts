import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorizeAdmin, writeAuditLog } from "@/lib/admin-auth";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorizeAdmin(request, "submission_viewer");
  if (!auth.ok) return auth.response;
  const admin = createAdminClient();
  const { data: entry } = await admin.from("entries").select("original_image_path").eq("id", Number(id)).single();
  if (!entry?.original_image_path) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { data, error } = await admin.storage.from("cos-originals").createSignedUrl(entry.original_image_path, 60);
  if (error || !data) return NextResponse.json({ error: "signed_url_failed" }, { status: 400 });
  await writeAuditLog({ context: auth.context, actionType: "original_image_view", targetType: "entry", targetId: id });
  return NextResponse.redirect(data.signedUrl);
}
