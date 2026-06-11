"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Building2, Plus, Trash2, UserPlus, ArrowLeft, Loader2, RefreshCw, Link2, CheckCircle2 } from "lucide-react";

const ACCENT = "#FF4747";

type Kb = { id: string; name: string; slug: string };
type AccessRow = { kb_id: string; user_id: string; profiles: { email: string } };

export default function AdminPage() {
  const [kbs, setKbs] = useState<Kb[]>([]);
  const [access, setAccess] = useState<AccessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [confluenceConnected, setConfluenceConnected] = useState(false);

  // Create KB form
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [creating, setCreating] = useState(false);

  // Assign user form — per KB
  const [assignEmail, setAssignEmail] = useState<Record<string, string>>({});
  const [assigning, setAssigning] = useState<Record<string, boolean>>({});

  // Confluence sync — per KB
  const [spaceUrl, setSpaceUrl] = useState<Record<string, string>>({});
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});
  const [syncResult, setSyncResult] = useState<Record<string, string>>({});

  async function load() {
    const res = await fetch("/api/admin");
    if (res.status === 403) { setForbidden(true); setLoading(false); return; }
    const json = await res.json();
    setKbs(json.kbs ?? []);
    setAccess(json.access ?? []);
    setConfluenceConnected(json.confluenceConnected ?? false);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function createKb(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_kb", name: newName, slug: newSlug }),
    });
    setNewName(""); setNewSlug("");
    setCreating(false);
    load();
  }

  async function assignUser(kbId: string) {
    const email = assignEmail[kbId]?.trim();
    if (!email) return;
    setAssigning((a) => ({ ...a, [kbId]: true }));
    await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "assign", kb_id: kbId, email }),
    });
    setAssignEmail((a) => ({ ...a, [kbId]: "" }));
    setAssigning((a) => ({ ...a, [kbId]: false }));
    load();
  }

  async function syncConfluence(kbId: string) {
    const url = spaceUrl[kbId]?.trim();
    if (!url) return;
    setSyncing((s) => ({ ...s, [kbId]: true }));
    setSyncResult((r) => ({ ...r, [kbId]: "Fetching pages from Confluence..." }));

    try {
      const res = await fetch("/api/admin/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kb_id: kbId, space_url: url }),
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        for (const line of text.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.message) setSyncResult((r) => ({ ...r, [kbId]: data.message }));
            if (data.type === "done" || data.type === "error") {
              setSyncing((s) => ({ ...s, [kbId]: false }));
            }
          } catch { /* partial chunk */ }
        }
      }
    } catch (e) {
      setSyncResult((r) => ({ ...r, [kbId]: `Error: ${String(e)}` }));
      setSyncing((s) => ({ ...s, [kbId]: false }));
    }
  }

  async function revokeUser(kbId: string, userId: string) {
    await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "revoke", kb_id: kbId, user_id: userId }),
    });
    load();
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0B0D10]">
        <Loader2 size={20} className="animate-spin text-[#5f6873]" />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#0B0D10] text-[#E8EAED]">
        <p className="text-sm text-[#8A919C]">You don&apos;t have admin access.</p>
        <Link href="/" className="text-xs text-[#5f6873] underline">Back to chat</Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B0D10] text-[#E8EAED]">
      {/* Header */}
      <header className="border-b border-[#262B33]">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md" style={{ backgroundColor: ACCENT }}>
              <Building2 size={16} className="text-white" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold">Horizontal</div>
              <div className="text-[11px] text-[#8A919C]">Admin Panel</div>
            </div>
          </div>
          <Link href="/" className="flex items-center gap-1.5 text-xs text-[#8A919C] hover:text-[#E8EAED]">
            <ArrowLeft size={13} /> Back to chat
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-8 flex flex-col gap-8">
        {/* Confluence connection */}
        <section className="rounded-xl border border-[#262B33] bg-[#15181E] p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium">Confluence</div>
              <div className="text-[11px] text-[#5f6873] mt-0.5">
                {confluenceConnected ? "Connected — you can sync any space you have access to" : "Connect your Atlassian account to sync project spaces"}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {confluenceConnected && (
                <div className="flex items-center gap-1.5 text-xs text-green-400">
                  <CheckCircle2 size={14} /> Connected
                </div>
              )}
              <a
                href="/api/auth/confluence"
                style={{ backgroundColor: confluenceConnected ? undefined : ACCENT }}
                className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium ${
                  confluenceConnected
                    ? "border border-[#262B33] text-[#8A919C] hover:text-[#E8EAED]"
                    : "text-white"
                }`}
              >
                <Link2 size={14} /> {confluenceConnected ? "Reconnect" : "Connect Confluence"}
              </a>
            </div>
          </div>
        </section>

        {/* Create project KB */}
        <section>
          <h2 className="mb-4 text-sm font-semibold">Create Project Knowledge Base</h2>
          <form onSubmit={createKb} className="flex gap-3">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
              placeholder="Project name (e.g. Acme Client)"
              className="flex-1 rounded-lg border border-[#262B33] bg-[#15181E] px-3 py-2 text-sm text-[#E8EAED] outline-none placeholder:text-[#5f6873] focus:border-[#3a414d]"
            />
            <input
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
              required
              placeholder="slug (e.g. acme)"
              className="w-36 rounded-lg border border-[#262B33] bg-[#15181E] px-3 py-2 text-sm text-[#E8EAED] outline-none placeholder:text-[#5f6873] focus:border-[#3a414d]"
            />
            <button
              type="submit"
              disabled={creating}
              style={{ backgroundColor: ACCENT }}
              className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {creating ? <Loader2 size={14} className="animate-spin" /> : <><Plus size={14} /> Create</>}
            </button>
          </form>
        </section>

        {/* Project KBs list */}
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold">Project Knowledge Bases</h2>
          {kbs.length === 0 && (
            <p className="text-sm text-[#5f6873]">No project KBs yet. Create one above.</p>
          )}
          {kbs.map((kb) => {
            const members = access.filter((a) => a.kb_id === kb.id);
            return (
              <div key={kb.id} className="rounded-xl border border-[#262B33] bg-[#15181E] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">{kb.name}</div>
                    <div className="text-[11px] text-[#5f6873]">slug: {kb.slug}</div>
                  </div>
                  <span className="text-[11px] text-[#8A919C]">{members.length} member{members.length !== 1 ? "s" : ""}</span>
                </div>

                {/* Members */}
                {members.length > 0 && (
                  <div className="mb-3 flex flex-col gap-1.5">
                    {members.map((m) => (
                      <div key={m.user_id} className="flex items-center justify-between rounded-lg bg-[#0B0D10] px-3 py-2">
                        <span className="text-xs text-[#C3C8D0]">{m.profiles?.email ?? m.user_id}</span>
                        <button
                          onClick={() => revokeUser(kb.id, m.user_id)}
                          className="text-[#5f6873] hover:text-[#FF4747]"
                          title="Revoke access"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add user */}
                <div className="flex gap-2">
                  <input
                    value={assignEmail[kb.id] ?? ""}
                    onChange={(e) => setAssignEmail((a) => ({ ...a, [kb.id]: e.target.value }))}
                    placeholder="user@horizontal.com"
                    className="flex-1 rounded-lg border border-[#262B33] bg-[#0B0D10] px-3 py-1.5 text-xs text-[#E8EAED] outline-none placeholder:text-[#5f6873] focus:border-[#3a414d]"
                  />
                  <button
                    onClick={() => assignUser(kb.id)}
                    disabled={assigning[kb.id]}
                    className="flex items-center gap-1 rounded-lg border border-[#262B33] bg-[#0B0D10] px-3 py-1.5 text-xs text-[#8A919C] hover:text-[#E8EAED] disabled:opacity-50"
                  >
                    {assigning[kb.id] ? <Loader2 size={12} className="animate-spin" /> : <><UserPlus size={12} /> Add</>}
                  </button>
                </div>

                {/* Confluence sync */}
                <div className="mt-3 border-t border-[#262B33] pt-3">
                  <div className="mb-1.5 text-[11px] font-medium text-[#5f6873]">Confluence Space</div>
                  <div className="flex gap-2">
                    <input
                      value={spaceUrl[kb.id] ?? ""}
                      onChange={(e) => setSpaceUrl((s) => ({ ...s, [kb.id]: e.target.value }))}
                      placeholder="Paste space or page URL from Confluence"
                      className="flex-1 rounded-lg border border-[#262B33] bg-[#0B0D10] px-3 py-1.5 text-xs text-[#E8EAED] outline-none placeholder:text-[#5f6873] focus:border-[#3a414d]"
                    />
                    <button
                      onClick={() => syncConfluence(kb.id)}
                      disabled={syncing[kb.id] || !spaceUrl[kb.id]?.trim()}
                      className="flex items-center gap-1 rounded-lg border border-[#262B33] bg-[#0B0D10] px-3 py-1.5 text-xs text-[#8A919C] hover:text-[#E8EAED] disabled:opacity-50"
                    >
                      {syncing[kb.id] ? <Loader2 size={12} className="animate-spin" /> : <><RefreshCw size={12} /> Sync</>}
                    </button>
                  </div>
                  {syncResult[kb.id] && (
                    <p className="mt-1.5 text-[11px] text-[#8A919C]">{syncResult[kb.id]}</p>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      </main>
    </div>
  );
}
