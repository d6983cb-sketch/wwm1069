import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  ADMIN_PERMISSIONS,
  type AdminPermission,
  type AdminPermissions,
  isSuperAdminDiscordId,
} from "@/lib/admin-access";

export type AdminProfile = {
  id: string;
  discord_id: string;
  nickname: string;
  is_admin: boolean;
  is_disqualified: boolean;
};

export type AdminContext = {
  profile: AdminProfile;
  isSuperAdmin: boolean;
  permissions: AdminPermissions;
  requestId: string;
};

export type AdminAuthResult =
  | { ok: true; context: AdminContext }
  | { ok: false; response: NextResponse };

function fullPermissions(): AdminPermissions {
  return Object.fromEntries(ADMIN_PERMISSIONS.map((permission) => [permission, true]));
}

export async function authorizeAdmin(
  request?: Request,
  permission?: AdminPermission,
  superAdminOnly = false,
): Promise<AdminAuthResult> {
  const supabase = await createClient();
  const admin = createAdminClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "unauthorized", message: "請先登入。" }, { status: 401 }),
    };
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("id,discord_id,nickname,is_admin,is_disqualified")
    .eq("id", user.id)
    .maybeSingle<AdminProfile>();
  if (!profile) {
    return {
      ok: false,
      response: NextResponse.json({ error: "profile_not_found", message: "找不到玩家資料。" }, { status: 404 }),
    };
  }

  const isSuperAdmin = isSuperAdminDiscordId(profile.discord_id);
  let permissions: AdminPermissions = {};
  if (isSuperAdmin) {
    permissions = fullPermissions();
  } else {
    const { data: role } = await admin
      .from("admin_roles")
      .select("permissions,is_active")
      .eq("profile_id", profile.id)
      .maybeSingle<{ permissions: AdminPermissions; is_active: boolean }>();
    if (role?.is_active) permissions = role.permissions ?? {};
  }

  const allowed = isSuperAdmin
    || (!superAdminOnly && (!permission || permissions[permission] === true));
  if (!allowed) {
    return {
      ok: false,
      response: NextResponse.json({ error: "forbidden", message: "權限不足。" }, { status: 403 }),
    };
  }

  return {
    ok: true,
    context: {
      profile,
      isSuperAdmin,
      permissions,
      requestId: request?.headers.get("x-request-id")?.slice(0, 120) || crypto.randomUUID(),
    },
  };
}

export async function writeAuditLog(input: {
  context: AdminContext;
  actionType: string;
  targetType?: string;
  targetId?: string | number;
  beforeData?: unknown;
  afterData?: unknown;
  result?: "success" | "failure";
  failureReason?: string;
}) {
  const admin = createAdminClient();
  await admin.from("audit_logs").insert({
    actor_profile_id: input.context.profile.id,
    actor_discord_id: input.context.profile.discord_id,
    actor_nickname: input.context.profile.nickname,
    action_type: input.actionType,
    target_type: input.targetType ?? null,
    target_id: input.targetId === undefined ? null : String(input.targetId),
    before_data: input.beforeData ?? null,
    after_data: input.afterData ?? null,
    request_id: input.context.requestId,
    result: input.result ?? "success",
    failure_reason: input.failureReason ?? null,
  });
}

export function cleanNickname(value: unknown) {
  return String(value ?? "").normalize("NFKC").trim();
}

export function normalizePermissions(value: unknown): AdminPermissions | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const result: AdminPermissions = {};
  for (const permission of ADMIN_PERMISSIONS) {
    result[permission] = source[permission] === true;
  }
  return result;
}

