// Session-refresh middleware. Keeps the user's auth cookies fresh on every
// request so Server Components see a valid session. Returns the response to
// pass through; do not run DB queries here.

import { createServerClient } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Bound the auth round-trip. This runs on every matched request, so an
// unreachable Supabase host (wrong project ref, DNS failure, outage) would
// otherwise hang here until Vercel kills the function at 25s — turning every
// route, /login included, into a 504 with no usable error.
//
// Two bounds are needed, not one. auth-js retries a failed token refresh with
// exponential backoff for up to AUTO_REFRESH_TICK_DURATION_MS (30s, see
// GoTrueClient._refreshAccessToken) — longer than Vercel's 25s limit — so a
// per-request timeout alone just gets retried until the function is killed.
// AUTH_TIMEOUT_MS bounds each attempt; AUTH_DEADLINE_MS bounds the total.
const AUTH_TIMEOUT_MS = 3_000;
const AUTH_DEADLINE_MS = 8_000;

export const updateSession = async (request: NextRequest) => {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl!, supabaseKey!, {
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: init?.signal ?? AbortSignal.timeout(AUTH_TIMEOUT_MS),
        }),
    },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // IMPORTANT: refresh the session right after creating the client.
  // Do not insert other logic between createServerClient and getUser.
  let user: User | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error(`auth deadline exceeded after ${AUTH_DEADLINE_MS}ms`)),
        AUTH_DEADLINE_MS,
      );
    });
    // getUser() resolves with { error } rather than throwing on a network
    // failure, so the catch below is only reached via the deadline — but both
    // paths land on user === null, which is what the gate keys off.
    const { data } = await Promise.race([supabase.auth.getUser(), deadline]);
    user = data.user;
  } catch (err) {
    // Fail closed: an unreachable auth service is treated as "not signed in",
    // so the redirect gate below still holds. The point is to return a fast
    // response instead of stalling the whole site behind a dead dependency.
    console.error(
      `[proxy] auth check failed for ${request.nextUrl.pathname}:`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    clearTimeout(deadlineTimer);
  }

  const { pathname } = request.nextUrl;
  const isAuthRoute = pathname.startsWith("/login") || pathname.startsWith("/signup");
  const isApiRoute = pathname.startsWith("/api/");

  if (!user && !isAuthRoute && !isApiRoute) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (user && isAuthRoute) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return supabaseResponse;
};
