import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";

export async function GET() {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.redirect(new URL("/login", process.env.NEXT_PUBLIC_APP_URL!));

  const state = crypto.randomUUID();
  cookieStore.set("confluence_oauth_state", state, { httpOnly: true, maxAge: 600, path: "/" });

  const params = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: process.env.CONFLUENCE_CLIENT_ID!,
    scope: "read:confluence-content.all read:confluence-space.summary read:confluence-content.summary search:confluence read:page:confluence read:space:confluence read:space-details:confluence read:content-details:confluence read:hierarchical-content:confluence read:folder:confluence offline_access",
    redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/confluence/callback`,
    state,
    response_type: "code",
    prompt: "consent",
  });

  return Response.redirect(`https://auth.atlassian.com/authorize?${params}`);
}
