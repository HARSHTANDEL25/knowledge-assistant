"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Building2, ArrowRight, Loader2 } from "lucide-react";
import { createClient } from "@/utils/supabase/client";

const ACCENT = "#FF4747";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setLoading(false);
    } else {
      router.push("/");
      router.refresh();
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0B0D10] px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-xl"
            style={{ backgroundColor: ACCENT }}
          >
            <Building2 size={20} className="text-white" />
          </div>
          <div className="text-center">
            <div className="text-lg font-semibold text-[#E8EAED]">Horizontal</div>
            <div className="text-sm text-[#8A919C]">Knowledge Assistant</div>
          </div>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-[#262B33] bg-[#15181E] p-6">
          <h1 className="mb-5 text-base font-semibold text-[#E8EAED]">Sign in</h1>

          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[#8A919C]">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                placeholder="you@horizontal.com"
                className="rounded-lg border border-[#262B33] bg-[#0B0D10] px-3 py-2.5 text-sm text-[#E8EAED] outline-none placeholder:text-[#5f6873] focus:border-[#3a414d]"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-[#8A919C]">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="rounded-lg border border-[#262B33] bg-[#0B0D10] px-3 py-2.5 text-sm text-[#E8EAED] outline-none placeholder:text-[#5f6873] focus:border-[#3a414d]"
              />
            </div>

            {error && (
              <p className="rounded-lg border border-[#ff474730] bg-[#ff47471a] px-3 py-2 text-xs text-[#ff7070]">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{ backgroundColor: ACCENT }}
              className="mt-1 flex items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-medium text-white transition-opacity disabled:opacity-50"
            >
              {loading ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <>Sign in <ArrowRight size={15} /></>
              )}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-xs text-[#5f6873]">
          No account?{" "}
          <Link href="/signup" className="text-[#8A919C] underline hover:text-[#E8EAED]">
            Create one
          </Link>
        </p>
      </div>
    </div>
  );
}
