import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Edit3,
  History,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  Shield,
  ShieldAlert,
  Unlock,
  Users,
} from 'lucide-react';
import { api } from '../api/client';
import { BottomSheet } from '../components/BottomSheet';
import type {
  AdminUser,
  AuthEventLog,
  AuthUser,
  UserRole,
  UserSessionLog,
} from '../types';
import { formatDateTimeSeconds } from '../utils/format';

interface AdminUsersPageProps {
  currentUser: AuthUser;
}

type AdminSection = 'users' | 'sessions' | 'events';

const ROLE_OPTIONS: Array<{ value: UserRole; label: string; desc: string }> = [
  { value: 'waiter', label: 'Pelayan', desc: 'Hanya akses Catat Nota' },
  { value: 'cashier', label: 'Kasir', desc: 'Hanya akses Kasir & Nota' },
  { value: 'owner', label: 'Pemilik', desc: 'Semua fitur operasional (tanpa menu Admin)' },
  { value: 'admin', label: 'Administrator', desc: 'Akses penuh termasuk Kelola Pengguna & Log' },
];

export function roleBadge(role: UserRole): { label: string; cls: string } {
  switch (role) {
    case 'admin':
      return { label: 'Admin', cls: 'bg-purple-100 text-purple-800 border-purple-200' };
    case 'owner':
      return { label: 'Pemilik', cls: 'bg-emerald-100 text-emerald-800 border-emerald-200' };
    case 'cashier':
      return { label: 'Kasir', cls: 'bg-sky-100 text-sky-800 border-sky-200' };
    case 'waiter':
      return { label: 'Pelayan', cls: 'bg-amber-100 text-amber-800 border-amber-200' };
  }
}

export function AdminUsersPage({ currentUser }: AdminUsersPageProps) {
  const [section, setSection] = useState<AdminSection>('users');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [sessions, setSessions] = useState<UserSessionLog[]>([]);
  const [events, setEvents] = useState<AuthEventLog[]>([]);
  const [filterUserId, setFilterUserId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Create user modal
  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newFullName, setNewFullName] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('waiter');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);

  // Edit user modal
  const [editTarget, setEditTarget] = useState<AdminUser | null>(null);
  const [editFullName, setEditFullName] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('waiter');
  const [editActive, setEditActive] = useState(true);

  // Reset password modal
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [resetPasswordVal, setResetPasswordVal] = useState('');

  const loadAll = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const uid = filterUserId ? Number(filterUserId) : undefined;
      const [uList, sList, eList] = await Promise.all([
        api.adminListUsers(),
        api.adminListSessions(uid, 150),
        api.adminListAuthEvents(uid, 150),
      ]);
      setUsers(uList);
      setSessions(sList);
      setEvents(eList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat data pengguna');
    } finally {
      setLoading(false);
    }
  }, [filterUserId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const stats = useMemo(() => {
    const total = users.length;
    const active = users.filter((u) => u.is_active).length;
    const locked = users.filter((u) => u.is_locked).length;
    const activeSessions = sessions.filter((s) => s.status === 'ACTIVE').length;
    return { total, active, locked, activeSessions };
  }, [users, sessions]);

  const handleCreateUser = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    try {
      setSaving(true);
      setError(null);
      setNotice(null);
      await api.adminCreateUser({
        username: newUsername.trim(),
        full_name: newFullName.trim(),
        role: newRole,
        password: newPassword,
      });
      setCreateOpen(false);
      setNewUsername('');
      setNewFullName('');
      setNewRole('waiter');
      setNewPassword('');
      setNotice('Pengguna baru berhasil ditambahkan.');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membuat pengguna');
    } finally {
      setSaving(false);
    }
  };

  const openEditModal = (u: AdminUser) => {
    setEditTarget(u);
    setEditFullName(u.full_name);
    setEditRole(u.role);
    setEditActive(u.is_active);
    setError(null);
  };

  const handleUpdateUser = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!editTarget) return;
    try {
      setSaving(true);
      setError(null);
      setNotice(null);
      await api.adminUpdateUser(editTarget.id, {
        full_name: editFullName.trim(),
        role: editRole,
        is_active: editActive,
      });
      setEditTarget(null);
      setNotice(`Data pengguna '${editTarget.username}' berhasil diperbarui.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memperbarui pengguna');
    } finally {
      setSaving(false);
    }
  };

  const handleResetPassword = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!resetTarget) return;
    try {
      setSaving(true);
      setError(null);
      setNotice(null);
      await api.adminResetPassword(resetTarget.id, resetPasswordVal);
      setResetTarget(null);
      setResetPasswordVal('');
      setNotice(`Password pengguna '${resetTarget.username}' berhasil direset.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal mereset password');
    } finally {
      setSaving(false);
    }
  };

  const handleUnlockUser = async (u: AdminUser) => {
    try {
      setError(null);
      setNotice(null);
      await api.adminUnlockUser(u.id);
      setNotice(`Kunci akun '${u.username}' berhasil dibuka.`);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membuka kunci akun');
    }
  };

  const sessionStatusBadge = (status: UserSessionLog['status']) => {
    switch (status) {
      case 'ACTIVE':
        return (
          <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-700">
            Aktif
          </span>
        );
      case 'LOGGED_OUT':
        return (
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-bold text-slate-600">
            Logout
          </span>
        );
      case 'EXPIRED':
        return (
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold text-amber-700">
            Kedaluwarsa
          </span>
        );
    }
  };

  const eventBadge = (type: AuthEventLog['event_type']) => {
    switch (type) {
      case 'LOGIN_SUCCESS':
        return <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-700">Login</span>;
      case 'LOGOUT':
        return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-700">Logout</span>;
      case 'LOGIN_FAILED':
        return <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-700">Gagal Login</span>;
      case 'ACCOUNT_LOCKED':
        return <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">Terkunci</span>;
      case 'ACCOUNT_UNLOCKED':
        return <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-bold text-sky-700">Dibuka</span>;
    }
  };

  return (
    <div className="space-y-4">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-extrabold text-slate-900">
            Kelola Pengguna &amp; Log Login
          </h2>
          <p className="text-xs text-slate-500">
            Atur akun staf, buka kunci akun yang terkunci, dan pantau waktu login/logout.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadAll()}
            disabled={loading}
            className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Muat Ulang</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setCreateOpen(true);
            }}
            className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-brand-orange px-3.5 text-xs font-bold text-white shadow-sm hover:bg-brand-orange-dark"
          >
            <Plus className="h-4 w-4" />
            <span>Tambah Pengguna</span>
          </button>
        </div>
      </div>

      {/* KPI Summary */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-3.5">
          <p className="text-xs font-semibold text-slate-500">Total Pengguna</p>
          <p className="mt-1 text-2xl font-extrabold text-slate-900">{stats.total}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3.5">
          <p className="text-xs font-semibold text-slate-500">Akun Aktif</p>
          <p className="mt-1 text-2xl font-extrabold text-emerald-700">{stats.active}</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3.5">
          <p className="text-xs font-semibold text-slate-500">Akun Terkunci</p>
          <p className={`mt-1 text-2xl font-extrabold ${stats.locked > 0 ? 'text-amber-600' : 'text-slate-900'}`}>
            {stats.locked}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-3.5">
          <p className="text-xs font-semibold text-slate-500">Sesi Login Aktif</p>
          <p className="mt-1 text-2xl font-extrabold text-sky-700">{stats.activeSessions}</p>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-800">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <span>{notice}</span>
        </div>
      )}

      {/* Sub-Section Tabs + User Filter */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1">
          <button
            type="button"
            onClick={() => setSection('users')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              section === 'users'
                ? 'bg-brand-orange text-white'
                : 'text-brand-brown/75 hover:bg-brand-cream'
            }`}
          >
            <Users className="h-3.5 w-3.5" />
            <span>Pengguna ({users.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setSection('sessions')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              section === 'sessions'
                ? 'bg-brand-orange text-white'
                : 'text-brand-brown/75 hover:bg-brand-cream'
            }`}
          >
            <Clock className="h-3.5 w-3.5" />
            <span>Riwayat Login / Logout</span>
          </button>
          <button
            type="button"
            onClick={() => setSection('events')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
              section === 'events'
                ? 'bg-brand-orange text-white'
                : 'text-brand-brown/75 hover:bg-brand-cream'
            }`}
          >
            <History className="h-3.5 w-3.5" />
            <span>Log Keamanan</span>
          </button>
        </div>

        {section !== 'users' && (
          <select
            value={filterUserId}
            onChange={(e) => setFilterUserId(e.target.value)}
            className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 focus:border-emerald-500 focus:outline-none"
          >
            <option value="">Semua Pengguna</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name} (@{u.username})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* SECTION 1: USERS */}
      {section === 'users' && (
        <div className="space-y-3">
          {users.map((u) => {
            const badge = roleBadge(u.role);
            return (
              <div
                key={u.id}
                className={`rounded-2xl border bg-white p-4 shadow-sm ${
                  u.is_locked ? 'border-amber-300 bg-amber-50/30' : 'border-slate-200'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-extrabold text-slate-900">
                        {u.full_name}
                      </span>
                      <span className="font-mono text-xs text-slate-500">@{u.username}</span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                      {u.is_env_admin && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                          <Shield className="h-3 w-3" />
                          ENV
                        </span>
                      )}
                      {!u.is_active && (
                        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-bold text-slate-600">
                          Nonaktif
                        </span>
                      )}
                      {u.is_locked && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">
                          <Lock className="h-3 w-3" />
                          Terkunci ({u.failed_login_attempts}x gagal)
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
                      <span>
                        <strong className="font-semibold text-slate-700">Login terakhir:</strong>{' '}
                        {formatDateTimeSeconds(u.last_login_at)}
                      </span>
                      <span>
                        <strong className="font-semibold text-slate-700">Logout terakhir:</strong>{' '}
                        {formatDateTimeSeconds(u.last_logout_at)}
                      </span>
                    </div>

                    {u.is_locked && (
                      <p className="flex items-center gap-1 text-xs font-medium text-amber-800">
                        <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                        {u.locked_until
                          ? `Terkunci otomatis hingga ${formatDateTimeSeconds(u.locked_until)}`
                          : 'Terkunci permanen hingga dibuka oleh Admin'}
                      </p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-2">
                    {u.is_locked && (
                      <button
                        type="button"
                        onClick={() => void handleUnlockUser(u)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-amber-500 px-3 text-xs font-bold text-white hover:bg-amber-600"
                      >
                        <Unlock className="h-3.5 w-3.5" />
                        <span>Buka Kunci</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => openEditModal(u)}
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                      <span>Edit</span>
                    </button>
                    {!u.is_env_admin && (
                      <button
                        type="button"
                        onClick={() => {
                          setResetTarget(u);
                          setResetPasswordVal('');
                          setError(null);
                        }}
                        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                        <span>Reset Password</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* SECTION 2: LOGIN / LOGOUT SESSIONS */}
      {section === 'sessions' && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Pengguna</th>
                  <th className="px-4 py-3">Peran</th>
                  <th className="px-4 py-3">Waktu Login</th>
                  <th className="px-4 py-3">Waktu Logout</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {sessions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                      Belum ada riwayat sesi login.
                    </td>
                  </tr>
                ) : (
                  sessions.map((s) => {
                    const badge = roleBadge(s.role);
                    return (
                      <tr key={s.id} className="hover:bg-slate-50/70">
                        <td className="px-4 py-3">
                          <div className="font-bold text-slate-900">{s.full_name}</div>
                          <div className="font-mono text-[11px] text-slate-500">@{s.username}</div>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${badge.cls}`}>
                            {badge.label}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 font-medium text-slate-800">
                          {formatDateTimeSeconds(s.login_at)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                          {s.logout_at ? formatDateTimeSeconds(s.logout_at) : '—'}
                        </td>
                        <td className="px-4 py-3">{sessionStatusBadge(s.status)}</td>
                        <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-slate-500">
                          {s.ip_address || '—'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SECTION 3: SECURITY AUDIT EVENTS */}
      {section === 'events' && (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs">
              <thead className="bg-slate-50 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Waktu</th>
                  <th className="px-4 py-3">Username</th>
                  <th className="px-4 py-3">Aktivitas</th>
                  <th className="px-4 py-3">Keterangan</th>
                  <th className="px-4 py-3">IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {events.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                      Belum ada log keamanan.
                    </td>
                  </tr>
                ) : (
                  events.map((ev) => (
                    <tr key={ev.id} className="hover:bg-slate-50/70">
                      <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                        {formatDateTimeSeconds(ev.created_at)}
                      </td>
                      <td className="px-4 py-3 font-mono font-semibold text-slate-900">
                        {ev.username}
                      </td>
                      <td className="px-4 py-3">{eventBadge(ev.event_type)}</td>
                      <td className="px-4 py-3 text-slate-600">{ev.detail}</td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-slate-500">
                        {ev.ip_address || '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* CREATE USER MODAL */}
      <BottomSheet
        open={createOpen}
        title="Tambah Pengguna Baru"
        subtitle="Pengguna baru akan login melalui halaman login yang sama."
        onClose={() => setCreateOpen(false)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              className="h-11 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleCreateUser()}
              className="h-11 rounded-xl bg-emerald-600 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {saving ? 'Menyimpan...' : 'Simpan Pengguna'}
            </button>
          </div>
        }
      >
        <form onSubmit={handleCreateUser} className="space-y-3.5">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">Username</label>
            <input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="cth: budi_pelayan"
              className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-sm focus:border-emerald-500 focus:outline-none"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">Nama Lengkap</label>
            <input
              type="text"
              value={newFullName}
              onChange={(e) => setNewFullName(e.target.value)}
              placeholder="cth: Budi Santoso"
              className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-sm focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">Peran (Role)</label>
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as UserRole)}
              className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3.5 text-sm focus:border-emerald-500 focus:outline-none"
            >
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} — {opt.desc}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">
              Password (minimal 8 karakter)
            </label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Masukkan password awal"
              className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-sm focus:border-emerald-500 focus:outline-none"
            />
          </div>
        </form>
      </BottomSheet>

      {/* EDIT USER MODAL */}
      <BottomSheet
        open={Boolean(editTarget)}
        title={`Edit Pengguna: ${editTarget?.username ?? ''}`}
        subtitle={
          editTarget?.is_env_admin
            ? 'Peran dan status akun admin utama dikunci oleh environment variable.'
            : 'Perubahan peran berlaku pada permintaan berikutnya.'
        }
        onClose={() => setEditTarget(null)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setEditTarget(null)}
              className="h-11 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleUpdateUser()}
              className="h-11 rounded-xl bg-emerald-600 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {saving ? 'Menyimpan...' : 'Simpan Perubahan'}
            </button>
          </div>
        }
      >
        <form onSubmit={handleUpdateUser} className="space-y-3.5">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">Nama Lengkap</label>
            <input
              type="text"
              value={editFullName}
              onChange={(e) => setEditFullName(e.target.value)}
              className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-sm focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-700">Peran (Role)</label>
            <select
              value={editRole}
              disabled={Boolean(editTarget?.is_env_admin) || editTarget?.id === currentUser.id}
              onChange={(e) => setEditRole(e.target.value as UserRole)}
              className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3.5 text-sm focus:border-emerald-500 focus:outline-none disabled:bg-slate-100 disabled:text-slate-500"
            >
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} — {opt.desc}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2.5 rounded-xl border border-slate-200 p-3 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              checked={editActive}
              disabled={Boolean(editTarget?.is_env_admin) || editTarget?.id === currentUser.id}
              onChange={(e) => setEditActive(e.target.checked)}
              className="h-4 w-4 rounded accent-emerald-600"
            />
            <span>Akun aktif (bisa login)</span>
          </label>
        </form>
      </BottomSheet>

      {/* RESET PASSWORD MODAL */}
      <BottomSheet
        open={Boolean(resetTarget)}
        title={`Reset Password: ${resetTarget?.username ?? ''}`}
        subtitle="Sesi login lama pengguna ini akan otomatis keluar dan akun akan terbuka jika sedang terkunci."
        onClose={() => setResetTarget(null)}
        footer={
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setResetTarget(null)}
              className="h-11 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700"
            >
              Batal
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleResetPassword()}
              className="h-11 rounded-xl bg-emerald-600 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {saving ? 'Menyimpan...' : 'Simpan Password Baru'}
            </button>
          </div>
        }
      >
        <form onSubmit={handleResetPassword}>
          <label className="mb-1 block text-xs font-semibold text-slate-700">
            Password Baru (minimal 8 karakter)
          </label>
          <input
            type="password"
            value={resetPasswordVal}
            onChange={(e) => setResetPasswordVal(e.target.value)}
            placeholder="Masukkan password baru"
            className="h-11 w-full rounded-xl border border-slate-200 px-3.5 text-sm focus:border-emerald-500 focus:outline-none"
            autoFocus
          />
        </form>
      </BottomSheet>
    </div>
  );
}
