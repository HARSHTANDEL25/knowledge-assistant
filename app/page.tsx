"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";
import { ArrowUp, Sparkles, FileText, Users, MonitorSmartphone, Building2, LogOut, FolderKanban, Settings, ChevronDown, ExternalLink } from "lucide-react";
import { createClient } from "@/utils/supabase/client";

type Source = { source_file: string; page_number: number | null; source_url?: string | null };
type Msg = { role: "user" | "assistant"; content: string; sources?: Source[] };
type ProjectKb = { id: string; name: string; slug: string };

const ACCENT = "#FF4747";
const ASSISTANT = "#5B8DEF";

const DEPARTMENTS = [
  {
    key: "hr",
    name: "HR",
    Icon: Users,
    placeholder: "Ask about leave, holidays, NPS, remote work…",
    suggestions: [
      "How many days of annual leave do I get?",
      "What are the holidays in 2026?",
      "How does the employee referral bonus work?",
    ],
  },
  {
    key: "it",
    name: "IT",
    Icon: MonitorSmartphone,
    placeholder: "Ask about security, VPN, MFA, IT setup…",
    suggestions: [
      "How do I set up multi-factor authentication?",
      "How can I access the VPN?",
      "How do I get IT support in India?",
    ],
  },
] as const;

const MD =
  "[&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1 [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_strong]:text-white [&_code]:rounded [&_code]:bg-[#262B33] [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[13px] [&_code]:font-mono [&_h1]:text-lg [&_h1]:font-bold [&_h2]:font-semibold [&_h2]:mt-3 [&_a]:underline [&_a]:text-[#7fa8ff] [&_table]:my-2 [&_th]:text-left [&_th]:pr-4 [&_td]:pr-4 [&_td]:py-0.5";

export default function Home() {
  const router = useRouter();
  const [kb, setKb] = useState<string>("hr");
  const [histories, setHistories] = useState<Record<string, Msg[]>>({ hr: [], it: [] });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [projectKbs, setProjectKbs] = useState<ProjectKb[]>([]);
  const [profileOpen, setProfileOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setProfileOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      setUserEmail(data.user.email ?? null);
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", data.user.id)
        .single();
      setUserRole(profile?.role ?? null);
      const res = await fetch("/api/projects");
      if (res.ok) setProjectKbs(await res.json());
    });
  }, []);

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  const staticDept = DEPARTMENTS.find((d) => d.key === kb);
  const projectDept = projectKbs.find((p) => p.slug === kb);
  const dept = staticDept ?? {
    name: projectDept?.name ?? kb,
    placeholder: "Ask anything about this project…",
    suggestions: [] as string[],
  };
  const messages = histories[kb] ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(text?: string) {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    setInput("");
    setBusy(true);
    const kbAtSend = kb;
    setHistories((h) => ({
      ...h,
      [kbAtSend]: [...(h[kbAtSend] ?? []), { role: "user", content: q }, { role: "assistant", content: "" }],
    }));

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, kb: kbAtSend }),
      });
      const srcHeader = res.headers.get("x-sources");
      const sources: Source[] = srcHeader ? JSON.parse(decodeURIComponent(srcHeader)) : [];
      if (!res.body) throw new Error("no body");

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        setHistories((h) => {
          const arr = [...h[kbAtSend]];
          arr[arr.length - 1] = { role: "assistant", content: acc, sources };
          return { ...h, [kbAtSend]: arr };
        });
      }
    } catch {
      setHistories((h) => {
        const arr = [...h[kbAtSend]];
        arr[arr.length - 1] = { role: "assistant", content: "Something went wrong. Please try again." };
        return { ...h, [kbAtSend]: arr };
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen flex-col bg-[#0B0D10] text-[#E8EAED]">
      {/* Header */}
      <header className="border-b border-[#262B33]">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-md"
              style={{ backgroundColor: ACCENT }}
            >
              <Building2 size={16} className="text-white" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold">Horizontal</div>
              <div className="text-[11px] text-[#8A919C]">Knowledge Assistant</div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Segmented KB switcher */}
            <div className="flex flex-wrap gap-1 rounded-lg border border-[#262B33] bg-[#15181E] p-1">
              {DEPARTMENTS.map((d) => {
                const active = kb === d.key;
                const I = d.Icon;
                return (
                  <button
                    key={d.key}
                    onClick={() => setKb(d.key)}
                    style={active ? { backgroundColor: ACCENT } : undefined}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                      active ? "text-white" : "text-[#8A919C] hover:text-[#E8EAED]"
                    }`}
                  >
                    <I size={15} /> {d.name}
                  </button>
                );
              })}
              {projectKbs.map((p) => {
                const active = kb === p.slug;
                return (
                  <button
                    key={p.slug}
                    onClick={() => setKb(p.slug)}
                    style={active ? { backgroundColor: ACCENT } : undefined}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                      active ? "text-white" : "text-[#8A919C] hover:text-[#E8EAED]"
                    }`}
                  >
                    <FolderKanban size={15} /> {p.name}
                  </button>
                );
              })}
            </div>

            {/* User + admin + logout */}
            {userEmail && (
              <div className="relative" ref={profileRef}>
                {/* Profile pill button */}
                <button
                  onClick={() => setProfileOpen((o) => !o)}
                  className="flex items-center gap-2 rounded-lg border border-[#262B33] bg-[#15181E] px-2.5 py-1.5 transition-colors hover:border-[#3a414d]"
                >
                  {/* Avatar initials */}
                  <div
                    className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold text-white"
                    style={{ backgroundColor: userRole === "super_admin" ? ACCENT : userRole === "project_admin" ? "#5B8DEF" : "#3a414d" }}
                  >
                    {userEmail[0].toUpperCase()}
                  </div>
                  <span className="max-w-25 truncate text-[11px] text-[#C3C8D0]">{userEmail.split("@")[0]}</span>
                  <ChevronDown size={11} className={`text-[#5f6873] transition-transform ${profileOpen ? "rotate-180" : ""}`} />
                </button>

                {/* Dropdown */}
                {profileOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1.5 w-52 rounded-xl border border-[#262B33] bg-[#15181E] shadow-xl">
                    {/* User info */}
                    <div className="px-3 py-2.5 border-b border-[#262B33]">
                      <p className="text-[11px] text-[#E8EAED] font-medium truncate">{userEmail}</p>
                      <p
                        className="text-[10px] font-semibold mt-0.5"
                        style={{ color: userRole === "super_admin" ? ACCENT : userRole === "project_admin" ? "#5B8DEF" : "#5f6873" }}
                      >
                        {userRole === "super_admin" ? "Super Admin" : userRole === "project_admin" ? "Project Admin" : "Employee"}
                      </p>
                    </div>

                    {/* Admin link */}
                    {(userRole === "super_admin" || userRole === "project_admin") && (
                      <Link
                        href="/admin"
                        onClick={() => setProfileOpen(false)}
                        className="flex items-center gap-2 px-3 py-2 text-[12px] text-[#8A919C] hover:bg-[#1C2026] hover:text-[#E8EAED] transition-colors"
                      >
                        <Settings size={13} />
                        {userRole === "super_admin" ? "Manage Admins" : "Manage Employees"}
                      </Link>
                    )}

                    {/* Sign out */}
                    <button
                      onClick={handleLogout}
                      className="flex w-full items-center gap-2 px-3 py-2 text-[12px] text-[#8A919C] hover:bg-[#1C2026] hover:text-[#FF4747] transition-colors rounded-b-xl"
                    >
                      <LogOut size={13} />
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-6">
          {messages.length === 0 ? (
            <div className="mt-20 flex flex-col items-center text-center">
              <div
                className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl"
                style={{ backgroundColor: "#15181E", border: "1px solid #262B33" }}
              >
                <Sparkles size={20} style={{ color: ASSISTANT }} />
              </div>
              <h2 className="text-lg font-semibold">Ask anything about {dept.name}</h2>
              <p className="mt-1 max-w-md text-sm text-[#8A919C]">
                Answers are grounded in Horizontal&apos;s {dept.name} documents, with sources cited.
              </p>
              <div className="mt-6 flex w-full max-w-md flex-col gap-2">
                {dept.suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="rounded-lg border border-[#262B33] bg-[#15181E] px-4 py-2.5 text-left text-sm text-[#C3C8D0] transition-colors hover:border-[#3a414d] hover:bg-[#1C2026]"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {messages.map((m, i) => {
                const isUser = m.role === "user";
                const streaming = busy && i === messages.length - 1 && !isUser && m.content.length > 0;

                if (isUser) {
                  return (
                    <div key={i} className="msg-in flex justify-end">
                      <div className="max-w-[80%] rounded-2xl bg-[#1C2026] px-4 py-2.5 text-[15px] leading-relaxed">
                        {m.content}
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={i} className="msg-in flex gap-3">
                    <div
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                      style={{ backgroundColor: "#15181E", border: `1px solid ${ASSISTANT}55` }}
                    >
                      <Sparkles size={15} style={{ color: ASSISTANT }} />
                    </div>
                    <div className="min-w-0 flex-1 text-[15px] leading-[1.65]">
                      {m.content ? (
                        <>
                          <span className="inline">
                            <div className={`${MD} inline`}>
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                            </div>
                            {streaming && <span className="caret ml-0.5 inline-block">▍</span>}
                          </span>
                          {m.sources && m.sources.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {m.sources.map((s, j) => {
                                const card = "flex flex-col gap-0.5 rounded-md border border-[#262B33] bg-[#15181E] px-2.5 py-1.5 text-[12px]";
                                const titleRow = (
                                  <span className="flex items-center gap-1.5 text-[#C3C8D0]">
                                    <FileText size={12} className="shrink-0 text-[#8A919C]" />
                                    <span className="max-w-[220px] truncate">{s.source_file}</span>
                                    {s.page_number != null && (
                                      <span className="text-[#5f6873]">· p.{s.page_number}</span>
                                    )}
                                  </span>
                                );
                                return s.source_url ? (
                                  <a
                                    key={j}
                                    href={s.source_url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    title={s.source_file}
                                    className={`${card} group transition-colors hover:border-[#3a414d]`}
                                  >
                                    {titleRow}
                                    <span className="flex items-center gap-1.5 text-[14px] text-[#5f6873] transition-colors group-hover:text-[#7fa8ff]">
                                      <ExternalLink size={12} className="shrink-0" />
                                      View in Confluence (click to open)
                                    </span>
                                  </a>
                                ) : (
                                  <span key={j} className={card} title={s.source_file}>
                                    {titleRow}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-[#8A919C]">
                          Thinking<span className="caret">…</span>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>
          )}
        </div>
      </main>

      {/* Input */}
      <div className="border-t border-[#262B33] bg-[#0B0D10]">
        <div className="mx-auto max-w-3xl px-5 py-4">
          <div className="relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
              placeholder={dept.placeholder}
              className="w-full resize-none rounded-xl border border-[#262B33] bg-[#15181E] py-3 pl-4 pr-12 text-sm outline-none placeholder:text-[#5f6873] focus:border-[#3a414d]"
            />
            <button
              onClick={() => send()}
              disabled={busy || !input.trim()}
              style={{ backgroundColor: ACCENT }}
              className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-white transition-opacity disabled:opacity-30"
              aria-label="Send"
            >
              <ArrowUp size={16} />
            </button>
          </div>
          <p className="mt-2 text-center text-[11px] text-[#5f6873]">
            Grounded in Horizontal documents · sources cited
          </p>
        </div>
      </div>
    </div>
  );
}
