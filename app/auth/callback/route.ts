import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const requestedNext = url.searchParams.get("next") || "/";
  const next = requestedNext.startsWith("/") && !requestedNext.startsWith("//")
    ? requestedNext
    : "/";
  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const guildId = process.env.DISCORD_GUILD_ID?.trim();
      if (guildId) {
        const token = data.session?.provider_token;
        const response = token
          ? await fetch("https://discord.com/api/v10/users/@me/guilds", {
              headers: { authorization: `Bearer ${token}` },
              cache: "no-store",
            })
          : null;
        const guilds = response?.ok
          ? await response.json() as Array<{ id?: string }>
          : [];
        if (!guilds.some((guild) => guild.id === guildId)) {
          await supabase.auth.signOut();
          return NextResponse.redirect(new URL("/?auth_error=not_guild_member", url.origin));
        }
      }
      return NextResponse.redirect(new URL(next, url.origin));
    }
  }
  return NextResponse.redirect(new URL("/?auth_error=1", url.origin));
}
