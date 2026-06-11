import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;

  const cookieStore = await cookies();
  const savedState = cookieStore.get("confluence_oauth_state")?.value;

  if (!code || !state || state !== savedState) {
    return Response.redirect(`${appUrl}/admin?error=oauth_failed`);
  }

  const supabase = createClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.redirect(`${appUrl}/login`);

  // Exchange code for tokens
  const tokenRes = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: process.env.CONFLUENCE_CLIENT_ID,
      client_secret: process.env.CONFLUENCE_CLIENT_SECRET,
      code,
      redirect_uri: `${appUrl}/api/auth/confluence/callback`,
    }),
  });

  if (!tokenRes.ok) {
    console.error("Token exchange failed:", await tokenRes.text());
    return Response.redirect(`${appUrl}/admin?error=token_exchange_failed`);
  }

  const tokens = await tokenRes.json();

  // Get Atlassian cloud ID for this user's site
  const resourcesRes = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json" },
  });
  const resources = await resourcesRes.json();
  const cloudId = resources[0]?.id;

  if (!cloudId) {
    return Response.redirect(`${appUrl}/admin?error=no_confluence_site`);
  }

  // Store tokens per user
  const db = createAdminClient();
  await db.from("confluence_tokens").upsert(
    {
      user_id: user.id,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? null,
      expires_at: new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString(),
      cloud_id: cloudId,
    },
    { onConflict: "user_id" },
  );

  return Response.redirect(`${appUrl}/admin?connected=true`);
}
