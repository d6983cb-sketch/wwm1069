import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");
  if (!expected || authorization !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: expired, error: readError } = await admin
    .from("audit_logs")
    .select("id")
    .lt("created_at", cutoff);
  if (readError) {
    await admin.from("audit_cleanup_runs").insert({ succeeded: false, failure_reason: readError.message });
    return NextResponse.json({ error: "cleanup_read_failed" }, { status: 500 });
  }
  const ids = (expired ?? []).map((item) => item.id);
  if (ids.length) {
    const { error } = await admin.from("audit_logs").delete().in("id", ids).lt("created_at", cutoff);
    if (error) {
      await admin.from("audit_cleanup_runs").insert({ succeeded: false, failure_reason: error.message });
      return NextResponse.json({ error: "cleanup_delete_failed" }, { status: 500 });
    }
  }
  await admin.from("audit_cleanup_runs").insert({ succeeded: true, deleted_count: ids.length });
  return NextResponse.json({ ok: true, deleted: ids.length, cutoff });
}

