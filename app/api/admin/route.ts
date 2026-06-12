import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const ADMIN_ROLES = ["super_admin", "project_admin"];

async function assertAdmin() {
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || !ADMIN_ROLES.includes(profile.role)) return null;
  return { user, role: profile.role as string };
}

// GET /api/admin — list project KBs with their members
// super_admin sees all; project_admin sees only their own KBs
export async function GET() {
  const admin = await assertAdmin();
  if (!admin) return Response.json({ error: "Forbidden" }, { status: 403 });

  const db = createAdminClient();
  const query = db
    .from("knowledge_bases")
    .select("id, name, slug, created_by")
    .eq("type", "project")
    .order("name");

  // project_admin only sees KBs they created
  if (admin.role === "project_admin") {
    query.eq("created_by", admin.user.id);
  }

  const { data: kbs } = await query;

  // Only fetch access rows for KBs this admin can see
  const kbIds = (kbs ?? []).map((k) => k.id);
  const { data: access } = kbIds.length
    ? await db.from("project_access").select("kb_id, user_id, profiles(email)").in("kb_id", kbIds)
    : { data: [] };

  // Check if this user has connected Confluence via OAuth
  const { data: tokenRow } = await db
    .from("confluence_tokens")
    .select("user_id")
    .eq("user_id", admin.user.id)
    .single();

  // super_admin gets the full user list for role management UI
  let users: { id: string; email: string; role: string }[] = [];
  if (admin.role === "super_admin") {
    const { data: allUsers } = await db
      .from("profiles")
      .select("id, email, role")
      .order("email");
    users = allUsers ?? [];
  }

  return Response.json({ kbs: kbs ?? [], access: access ?? [], confluenceConnected: !!tokenRow, users });
}

// POST /api/admin — create KB, assign, or revoke access
export async function POST(req: Request) {
  const admin = await assertAdmin();
  if (!admin) return Response.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json();
  const db = createAdminClient();

  // Create a new project KB — set created_by to the calling user
  if (body.action === "create_kb") {
    const { name, slug } = body;
    if (!name || !slug) return Response.json({ error: "name and slug required" }, { status: 400 });
    const { data, error } = await db
      .from("knowledge_bases")
      .upsert({ name, slug, type: "project", created_by: admin.user.id }, { onConflict: "slug" })
      .select()
      .single();
    if (error) return Response.json({ error: error.message }, { status: 400 });
    return Response.json(data);
  }

  // Assign a user to a project KB by email
  // project_admin can only assign to KBs they own
  if (body.action === "assign") {
    const { kb_id, email } = body;
    if (admin.role === "project_admin") {
      const { data: kb } = await db
        .from("knowledge_bases")
        .select("created_by")
        .eq("id", kb_id)
        .single();
      if (!kb || kb.created_by !== admin.user.id) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
    }
    const { data: profile } = await db
      .from("profiles")
      .select("id")
      .eq("email", email)
      .single();
    if (!profile) return Response.json({ error: "User not found — they must sign up first" }, { status: 404 });
    const { error } = await db
      .from("project_access")
      .upsert({ kb_id, user_id: profile.id }, { onConflict: "user_id,kb_id" });
    if (error) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ ok: true });
  }

  // Revoke access
  // project_admin can only revoke from KBs they own
  if (body.action === "revoke") {
    const { kb_id, user_id } = body;
    if (admin.role === "project_admin") {
      const { data: kb } = await db
        .from("knowledge_bases")
        .select("created_by")
        .eq("id", kb_id)
        .single();
      if (!kb || kb.created_by !== admin.user.id) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
      }
    }
    const { error } = await db
      .from("project_access")
      .delete()
      .eq("kb_id", kb_id)
      .eq("user_id", user_id);
    if (error) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ ok: true });
  }

  // Change a user's role — super_admin only
  if (body.action === "change_role") {
    if (admin.role !== "super_admin") {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    const { user_id, role } = body;
    const VALID_ROLES = ["employee", "project_admin", "super_admin"];
    if (!user_id || !VALID_ROLES.includes(role)) {
      return Response.json({ error: "Invalid user_id or role" }, { status: 400 });
    }
    const { error } = await db
      .from("profiles")
      .update({ role })
      .eq("id", user_id);
    if (error) return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ ok: true });
  }

  return Response.json({ error: "Unknown action" }, { status: 400 });
}
