// Service-role Supabase client. Bypasses RLS — INGESTION / SCRIPTS ONLY.
// NEVER import this on the chat/retrieval path (that must use the user-JWT
// client so RLS enforces project isolation).

import { createClient } from "@supabase/supabase-js";

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
