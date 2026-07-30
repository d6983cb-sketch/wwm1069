import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorizeAdmin, writeAuditLog } from "@/lib/admin-auth";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorizeAdmin(request, "submission_viewer");
  if (!auth.ok) return auth.response;
  const admin = createAdminClient();
  const [{ data: entry }, { data: revision }] = await Promise.all([
    admin.from("entries").select("original_image_path").eq("id", Number(id)).single(),
    admin.from("entry_original_image_revisions")
      .select("storage_object_path")
      .eq("entry_id", Number(id))
      .eq("is_active", true)
      .maybeSingle(),
  ]);
  const activePath = revision?.storage_object_path ?? entry?.original_image_path;
  if (!activePath) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { data, error } = await admin.storage.from("cos-originals").createSignedUrl(activePath, 60);
  if (error || !data) return NextResponse.json({ error: "signed_url_failed" }, { status: 400 });
  await writeAuditLog({ context: auth.context, actionType: "original_image_view", targetType: "entry", targetId: id });
  return NextResponse.redirect(data.signedUrl);
}
