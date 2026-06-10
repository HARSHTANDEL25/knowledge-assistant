import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";

export async function GET() {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json([], { status: 401 });

  const { data } = await supabase
    .from("project_access")
    .select("knowledge_bases(id, name, slug)")
    .eq("user_id", user.id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const kbs = (data ?? []).map((r: any) => r.knowledge_bases).filter(Boolean);
  return Response.json(kbs);
}
