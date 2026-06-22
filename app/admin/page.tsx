"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Building2,
  Plus,
  Trash2,
  UserPlus,
  ArrowLeft,
  Loader2,
  RefreshCw,
  Link2,
  CheckCircle2,
  Users,
  Pencil,
  Check,
  X,
  Cloud,
} from "lucide-react";

const ACCENT = "#FF4747";

type Kb = { id: string; name: string; slug: string };
type AccessRow = {
  kb_id: string;
  user_id: string;
  profiles: { email: string };
};
type UserRow = { id: string; email: string; role: string };

type DriveFolder = {
  name: string;
  driveCount: number;
  synced: number;
  unsynced: string[];
  failed: string[];
  stale: string[];
  url: string;
};

const ROLE_LABELS: Record<string, string> = {
  employee: "Employee",
  project_admin: "Project Admin",
  super_admin: "Super Admin",
};

export default function AdminPage() {
  const [kbs, setKbs] = useState<Kb[]>([]);
  const [access, setAccess] = useState<AccessRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [confluenceConnected, setConfluenceConnected] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [changingRole, setChangingRole] = useState<Record<string, boolean>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deletingKb, setDeletingKb] = useState<Record<string, boolean>>({});
  const [createError, setCreateError] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<Record<string, string>>({});
  const [editingKb, setEditingKb] = useState<string | null>(null);
  const [editName, setEditName] = useState<Record<string, string>>({});
  const [savingKb, setSavingKb] = useState<Record<string, boolean>>({});

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

  // Google Drive sync — global (HR + IT folders)
  // driveBusy holds the action currently running ("hr" | "it" | "all" | "full"), or null when idle.
  const [driveBusy, setDriveBusy] = useState<string | null>(null);
  const [driveResult, setDriveResult] = useState<string>("");
  const [driveStatus, setDriveStatus] = useState<{
    configured: boolean;
    folders?: DriveFolder[];
    error?: string;
  } | null>(null);

  async function loadDriveStatus() {
    try {
      const res = await fetch("/api/admin/sync-gdrive");
      if (res.ok) setDriveStatus(await res.json());
    } catch {
      /* ignore */
    }
  }

  async function load() {
    const res = await fetch("/api/admin");
    if (res.status === 403) {
      setForbidden(true);
      setLoading(false);
      return;
    }
    const json = await res.json();
    setKbs(json.kbs ?? []);
    setAccess(json.access ?? []);
    setUsers(json.users ?? []);
    setConfluenceConnected(json.confluenceConnected ?? false);
    setIsSuperAdmin(json.callerRole === "super_admin");
    setLoading(false);
  }

  async function changeRole(userId: string, role: string) {
    setChangingRole((c) => ({ ...c, [userId]: true }));
    await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "change_role", user_id: userId, role }),
    });
    setChangingRole((c) => ({ ...c, [userId]: false }));
    load();
  }

  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (isSuperAdmin) loadDriveStatus();
  }, [isSuperAdmin]);

  async function createKb(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    const res = await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_kb",
        name: newName,
        slug: newSlug,
      }),
    });
    if (!res.ok) {
      const json = await res.json();
      setCreateError(json.error ?? "Failed to create KB");
    } else {
      setNewName("");
      setNewSlug("");
    }
    setCreating(false);
    load();
  }

  async function assignUser(kbId: string) {
    const email = assignEmail[kbId]?.trim();
    if (!email) return;
    setAssigning((a) => ({ ...a, [kbId]: true }));
    setAssignError((e) => ({ ...e, [kbId]: "" }));
    const res = await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "assign", kb_id: kbId, email }),
    });
    if (!res.ok) {
      const json = await res.json();
      setAssignError((e) => ({
        ...e,
        [kbId]: json.error ?? "Failed to assign user",
      }));
    } else {
      setAssignEmail((a) => ({ ...a, [kbId]: "" }));
    }
    setAssigning((a) => ({ ...a, [kbId]: false }));
    load();
  }

  async function syncConfluence(kbId: string) {
    const url = spaceUrl[kbId]?.trim();
    if (!url) return;
    setSyncing((s) => ({ ...s, [kbId]: true }));
    setSyncResult((r) => ({
      ...r,
      [kbId]: "Fetching pages from Confluence...",
    }));

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
            if (data.message)
              setSyncResult((r) => ({ ...r, [kbId]: data.message }));
            if (data.type === "done" || data.type === "error") {
              setSyncing((s) => ({ ...s, [kbId]: false }));
            }
          } catch {
            /* partial chunk */
          }
        }
      }
    } catch (e) {
      setSyncResult((r) => ({ ...r, [kbId]: `Error: ${String(e)}` }));
      setSyncing((s) => ({ ...s, [kbId]: false }));
    }
  }

  async function syncGdrive(scope: "hr" | "it" | "all", full = false) {
    setDriveBusy(full ? "full" : scope);
    setDriveResult("Connecting to Google Drive...");
    try {
      const res = await fetch("/api/admin/sync-gdrive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, full }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setDriveResult(`Error: ${json.error ?? res.statusText}`);
        setDriveBusy(null);
        return;
      }
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
            if (data.message) setDriveResult(data.message);
            if (data.type === "done" || data.type === "error") {
              setDriveBusy(null);
              loadDriveStatus();
            }
          } catch {
            /* partial chunk */
          }
        }
      }
    } catch (e) {
      setDriveResult(`Error: ${String(e)}`);
      setDriveBusy(null);
    }
  }

  async function deleteKb(kbId: string) {
    setDeletingKb((d) => ({ ...d, [kbId]: true }));
    setConfirmDelete(null);
    await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_kb", kb_id: kbId }),
    });
    setDeletingKb((d) => ({ ...d, [kbId]: false }));
    load();
  }

  async function updateKb(kbId: string) {
    const name = editName[kbId]?.trim();
    if (!name) return;
    setSavingKb((s) => ({ ...s, [kbId]: true }));
    await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_kb", kb_id: kbId, name }),
    });
    setSavingKb((s) => ({ ...s, [kbId]: false }));
    setEditingKb(null);
    load();
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
        <p className="text-sm text-[#8A919C]">
          You don&apos;t have admin access.
        </p>
        <Link href="/" className="text-xs text-[#5f6873] underline">
          Back to chat
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B0D10] text-[#E8EAED]">
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
              <div className="text-[11px] text-[#8A919C]">Admin Panel</div>
            </div>
          </div>
          <Link
            href="/"
            className="flex items-center gap-1.5 text-xs text-[#8A919C] hover:text-[#E8EAED]"
          >
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
                {confluenceConnected
                  ? "Connected — you can sync any space you have access to"
                  : "Connect your Atlassian account to sync project spaces"}
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
                style={{
                  backgroundColor: confluenceConnected ? undefined : ACCENT,
                }}
                className={`flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium ${
                  confluenceConnected
                    ? "border border-[#262B33] text-[#8A919C] hover:text-[#E8EAED]"
                    : "text-white"
                }`}
              >
                <Link2 size={14} />{" "}
                {confluenceConnected ? "Reconnect" : "Connect Confluence"}
              </a>
            </div>
          </div>
        </section>

        {/* Google Drive sync — HR + IT (super_admin only) */}
        {isSuperAdmin && (
          <section className="rounded-xl border border-[#262B33] bg-[#15181E] p-4">
            <div className="flex flex-col gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <Cloud size={14} className="text-[#5f6873]" /> Google Drive
                  (HR &amp; IT)
                </div>
                <div className="mt-0.5 text-[11px] text-[#5f6873]">
                  Per-folder sync only ingests PDFs that aren&apos;t synced yet. Full re-sync re-ingests every PDF (use after edits).
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(["hr", "it"] as const).map((slug) => {
                  const folder = driveStatus?.folders?.find((f) => f.name.toLowerCase() === slug);
                  const newCount = folder?.unsynced.length ?? 0;
                  return (
                    <button
                      key={slug}
                      onClick={() => syncGdrive(slug)}
                      disabled={driveBusy !== null}
                      className="flex items-center gap-1.5 rounded-lg border border-[#262B33] px-3 py-1.5 text-sm font-medium text-[#C3C8D0] hover:border-[#3a414d] disabled:opacity-50"
                    >
                      {driveBusy === slug ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                      Sync {slug.toUpperCase()}
                      {newCount > 0 && (
                        <span className="rounded bg-[#3a2a12] px-1 text-[10px] text-[#f0b429]">{newCount} new</span>
                      )}
                    </button>
                  );
                })}
                <button
                  onClick={() => syncGdrive("all", true)}
                  disabled={driveBusy !== null}
                  className="flex items-center gap-1.5 rounded-lg border border-[#262B33] px-3 py-1.5 text-sm font-medium text-[#8A919C] hover:border-[#3a414d] hover:text-[#E8EAED] disabled:opacity-50"
                >
                  {driveBusy === "full" ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  Full re-sync
                </button>
              </div>
            </div>

            {driveStatus?.configured === false && (
              <p className="mt-2 text-[11px] text-[#FF4747]">
                Not configured — set GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY,
                DRIVE_HR_FOLDER_ID, DRIVE_IT_FOLDER_ID.
              </p>
            )}
            {driveStatus?.error && (
              <p className="mt-2 text-[11px] text-[#FF4747]">
                Drive error: {driveStatus.error}
              </p>
            )}
            {driveStatus?.folders && (
              <div className="mt-3 flex flex-col gap-2 border-t border-[#262B33] pt-3">
                {driveStatus.folders.map((f) => (
                  <div key={f.name} className="text-[11px]">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-[#C3C8D0]">
                        {f.name}
                      </span>
                      :
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#5f6873] hover:text-[#E8EAED] underline text-[11px] flex items-center gap-1"
                      >
                        Open folder
                      </a>
                      <span className="text-[#5f6873]">
                        {f.synced}/{f.driveCount} synced
                      </span>
                      {f.unsynced.length > 0 && (
                        <span className="rounded bg-[#3a2a12] px-1.5 py-0.5 text-[10px] font-medium text-[#f0b429]">
                          {f.unsynced.length} new — not synced yet
                        </span>
                      )}
                      {f.failed?.length > 0 && (
                        <span className="rounded bg-[#2a1212] px-1.5 py-0.5 text-[10px] font-medium text-[#FF4747]">
                          {f.failed.length} failed (no text)
                        </span>
                      )}
                      {f.stale.length > 0 && (
                        <span className="rounded bg-[#2a1212] px-1.5 py-0.5 text-[10px] font-medium text-[#FF4747]">
                          {f.stale.length} extra (not in Drive)
                        </span>
                      )}
                    </div>
                    {f.unsynced.length > 0 && (
                      <div className="mt-0.5 text-[#5f6873]">
                        New: {f.unsynced.join(", ")}
                      </div>
                    )}
                    {f.failed?.length > 0 && (
                      <div className="mt-0.5 text-[#5f6873]">
                        Failed — no extractable text (image/scanned PDF, OCR coming later): {f.failed.join(", ")}
                      </div>
                    )}
                    {f.stale.length > 0 && (
                      <div className="mt-0.5 text-[#5f6873]">
                        In Supabase but not in Drive: {f.stale.join(", ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {driveResult && (
              <p className="mt-2 text-[11px] text-[#8A919C]">{driveResult}</p>
            )}
          </section>
        )}

        {/* Create project KB */}
        <section>
          <h2 className="mb-4 text-sm font-semibold">
            Create Project Knowledge Base
          </h2>
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
              onChange={(e) =>
                setNewSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"))
              }
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
              {creating ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <>
                  <Plus size={14} /> Create
                </>
              )}
            </button>
          </form>
          {createError && (
            <p className="mt-2 text-xs text-[#FF4747]">{createError}</p>
          )}
        </section>

        {/* Project KBs list */}
        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold">Project Knowledge Bases</h2>
          {kbs.length === 0 && (
            <p className="text-sm text-[#5f6873]">
              No project KBs yet. Create one above.
            </p>
          )}
          {kbs.map((kb) => {
            const members = access.filter((a) => a.kb_id === kb.id);
            return (
              <div
                key={kb.id}
                className="rounded-xl border border-[#262B33] bg-[#15181E] p-4"
              >
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex-1 min-w-0 mr-3">
                    {editingKb === kb.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          value={editName[kb.id] ?? kb.name}
                          onChange={(e) =>
                            setEditName((n) => ({
                              ...n,
                              [kb.id]: e.target.value,
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter") updateKb(kb.id);
                            if (e.key === "Escape") setEditingKb(null);
                          }}
                          className="flex-1 rounded-md border border-[#3a414d] bg-[#0B0D10] px-2 py-1 text-sm text-[#E8EAED] outline-none focus:border-[#5f6873]"
                        />
                        <button
                          onClick={() => updateKb(kb.id)}
                          disabled={savingKb[kb.id]}
                          title="Save"
                          className="flex items-center justify-center rounded-md p-1 text-green-400 hover:bg-[#1e2730] disabled:opacity-50"
                        >
                          {savingKb[kb.id] ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Check size={14} />
                          )}
                        </button>
                        <button
                          onClick={() => setEditingKb(null)}
                          title="Cancel"
                          className="flex items-center justify-center rounded-md p-1 text-[#5f6873] hover:bg-[#1e2730] hover:text-[#E8EAED]"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{kb.name}</span>
                        <button
                          onClick={() => {
                            setEditingKb(kb.id);
                            setEditName((n) => ({ ...n, [kb.id]: kb.name }));
                          }}
                          title="Rename"
                          className="flex items-center justify-center rounded-md p-1 text-[#5f6873] hover:bg-[#1e2730] hover:text-[#E8EAED] transition-colors"
                        >
                          <Pencil size={13} />
                        </button>
                      </div>
                    )}
                    <div className="text-[11px] text-[#5f6873] mt-0.5">
                      slug: {kb.slug}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] text-[#8A919C]">
                      {members.length} member{members.length !== 1 ? "s" : ""}
                    </span>
                    {deletingKb[kb.id] ? (
                      <Loader2
                        size={14}
                        className="animate-spin text-[#5f6873]"
                      />
                    ) : confirmDelete === kb.id ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-[#8A919C]">
                          Delete?
                        </span>
                        <button
                          onClick={() => deleteKb(kb.id)}
                          className="rounded px-2 py-0.5 text-[11px] font-medium text-white"
                          style={{ backgroundColor: ACCENT }}
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="rounded border border-[#262B33] px-2 py-0.5 text-[11px] text-[#8A919C] hover:text-[#E8EAED]"
                        >
                          No
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(kb.id)}
                        className="text-[#5f6873] hover:text-[#FF4747] transition-colors"
                        title="Delete KB"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Members */}
                {members.length > 0 && (
                  <div className="mb-3 flex flex-col gap-1.5">
                    {members.map((m) => (
                      <div
                        key={m.user_id}
                        className="flex items-center justify-between rounded-lg bg-[#0B0D10] px-3 py-2"
                      >
                        <span className="text-xs text-[#C3C8D0]">
                          {m.profiles?.email ?? m.user_id}
                        </span>
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
                    onChange={(e) =>
                      setAssignEmail((a) => ({ ...a, [kb.id]: e.target.value }))
                    }
                    placeholder="user@horizontal.com"
                    className="flex-1 rounded-lg border border-[#262B33] bg-[#0B0D10] px-3 py-1.5 text-xs text-[#E8EAED] outline-none placeholder:text-[#5f6873] focus:border-[#3a414d]"
                  />
                  <button
                    onClick={() => assignUser(kb.id)}
                    disabled={assigning[kb.id]}
                    className="flex items-center gap-1 rounded-lg border border-[#262B33] bg-[#0B0D10] px-3 py-1.5 text-xs text-[#8A919C] hover:text-[#E8EAED] disabled:opacity-50"
                  >
                    {assigning[kb.id] ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <>
                        <UserPlus size={12} /> Add
                      </>
                    )}
                  </button>
                </div>
                {assignError[kb.id] && (
                  <p className="mt-1.5 text-[11px] text-[#FF4747]">
                    {assignError[kb.id]}
                  </p>
                )}

                {/* Confluence sync */}
                <div className="mt-3 border-t border-[#262B33] pt-3">
                  <div className="mb-1.5 text-[11px] font-medium text-[#5f6873]">
                    Confluence Space
                  </div>
                  <div className="flex gap-2">
                    <input
                      value={spaceUrl[kb.id] ?? ""}
                      onChange={(e) =>
                        setSpaceUrl((s) => ({ ...s, [kb.id]: e.target.value }))
                      }
                      placeholder="Paste space or page URL from Confluence"
                      className="flex-1 rounded-lg border border-[#262B33] bg-[#0B0D10] px-3 py-1.5 text-xs text-[#E8EAED] outline-none placeholder:text-[#5f6873] focus:border-[#3a414d]"
                    />
                    <button
                      onClick={() => syncConfluence(kb.id)}
                      disabled={syncing[kb.id] || !spaceUrl[kb.id]?.trim()}
                      className="flex items-center gap-1 rounded-lg border border-[#262B33] bg-[#0B0D10] px-3 py-1.5 text-xs text-[#8A919C] hover:text-[#E8EAED] disabled:opacity-50"
                    >
                      {syncing[kb.id] ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <>
                          <RefreshCw size={12} /> Sync
                        </>
                      )}
                    </button>
                  </div>
                  {syncResult[kb.id] && (
                    <p className="mt-1.5 text-[11px] text-[#8A919C]">
                      {syncResult[kb.id]}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        {/* User role management — super_admin only */}
        {isSuperAdmin && (
          <section className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Users size={14} className="text-[#5f6873]" />
              <h2 className="text-sm font-semibold">Manage User Roles</h2>
            </div>
            <div className="rounded-xl border border-[#262B33] bg-[#15181E] overflow-hidden">
              {users.map((u, i) => (
                <div
                  key={u.id}
                  className={`flex items-center justify-between px-4 py-2.5 ${i !== 0 ? "border-t border-[#262B33]" : ""}`}
                >
                  <span className="text-xs text-[#C3C8D0] truncate max-w-[55%]">
                    {u.email}
                  </span>
                  <div className="flex items-center gap-2">
                    {changingRole[u.id] && (
                      <Loader2
                        size={12}
                        className="animate-spin text-[#5f6873]"
                      />
                    )}
                    <select
                      value={u.role}
                      disabled={changingRole[u.id]}
                      onChange={(e) => changeRole(u.id, e.target.value)}
                      className="rounded-md border border-[#262B33] bg-[#0B0D10] px-2 py-1 text-xs text-[#C3C8D0] outline-none focus:border-[#3a414d] disabled:opacity-50"
                    >
                      {Object.entries(ROLE_LABELS).map(([val, label]) => (
                        <option key={val} value={val}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
