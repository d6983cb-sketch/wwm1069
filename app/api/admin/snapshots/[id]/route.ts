import { NextResponse } from "next/server";
import { authorizeAdmin, writeAuditLog } from "@/lib/admin-auth";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeAdmin(request, "report_viewer");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const admin = createAdminClient();
  const { data: snapshot } = await admin.from("activity_snapshots").select("*").eq("id", id).maybeSingle();
  if (!snapshot) return NextResponse.json({ error: "snapshot_not_found", message: "找不到快照。" }, { status: 404 });
  await writeAuditLog({ context: auth.context, actionType: "snapshot_export", targetType: "snapshot", targetId: id });
  return NextResponse.json(snapshot, {
    headers: {
      "content-disposition": `attachment; filename="activity-snapshot-${id}.json"`,
      "cache-control": "no-store",
    },
  });
}

