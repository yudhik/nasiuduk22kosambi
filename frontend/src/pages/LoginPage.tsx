import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Eye,
  EyeOff,
  Lock,
  LogIn,
  ShieldAlert,
  User,
} from 'lucide-react';
import { api, ApiError } from '../api/client';
import { STORE_NAME, type AuthUser } from '../types';

interface LoginPageProps {
  onLoginSuccess: (user: AuthUser) => void;
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLockedError, setIsLockedError] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api
      .health()
      .then((h) => {
        if (!active || !h.version) return;
        const sha = h.git_sha && h.git_sha !== 'unknown' ? ` (${h.git_sha})` : '';
        setAppVersion(`v${h.version}${sha}`);
      })
      .catch(() => {
        // ignore silent version fetch errors on login screen
      });
    return () => {
      active = false;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanedUsername = username.trim();
    if (!cleanedUsername || !password) {
      setError('Masukkan username dan password Anda.');
      setIsLockedError(false);
      return;
    }

    try {
      setSubmitting(true);
      setError(null);
      setIsLockedError(false);
      const user = await api.login(cleanedUsername, password);
      onLoginSuccess(user);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setIsLockedError(err.status === 423 || err.code === 'ACCOUNT_LOCKED');
      } else {
        setError(err instanceof Error ? err.message : 'Gagal login. Coba lagi.');
        setIsLockedError(false);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-brand-cream to-brand-cream-deep px-4 py-10">
      <div className="w-full max-w-md">
        {/* Static Logo & Brand Header */}
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 h-24 w-24 overflow-hidden rounded-3xl border-2 border-brand-amber-soft bg-brand-cream shadow-md">
            <img
              src="/logo.jpeg"
              alt={STORE_NAME}
              className="h-full w-full object-cover"
            />
          </div>
          <h1 className="text-xl font-extrabold tracking-tight text-brand-brown">
            {STORE_NAME}
          </h1>
        </div>

        {/* Unified Login Card (all roles including Admin) */}
        <div className="rounded-2xl border border-brand-amber-soft bg-white p-6 shadow-md shadow-brand-brown/5 sm:p-7">
          {error && (
            <div
              className={`mb-5 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm ${
                isLockedError
                  ? 'border-amber-300 bg-amber-50 text-amber-900'
                  : 'border-rose-200 bg-rose-50 text-rose-800'
              }`}
            >
              {isLockedError ? (
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              ) : (
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
              )}
              <span className="leading-snug">{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="login-username"
                className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-brand-brown/80"
              >
                Username
              </label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-brown/40" />
                <input
                  id="login-username"
                  type="text"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Masukkan username"
                  disabled={submitting}
                  className="h-11 w-full rounded-xl border border-brand-amber-soft bg-white pl-10 pr-3.5 text-base text-brand-brown placeholder:text-stone-400 focus:border-brand-orange focus:outline-none focus:ring-2 focus:ring-brand-orange/20 sm:text-sm"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="login-password"
                className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-brand-brown/80"
              >
                Password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-brand-brown/40" />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Masukkan password"
                  disabled={submitting}
                  className="h-11 w-full rounded-xl border border-brand-amber-soft bg-white pl-10 pr-11 text-base text-brand-brown placeholder:text-stone-400 focus:border-brand-orange focus:outline-none focus:ring-2 focus:ring-brand-orange/20 sm:text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-2.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-brand-brown/50 hover:bg-brand-cream hover:text-brand-brown"
                  aria-label={showPassword ? 'Sembunyikan password' : 'Lihat password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="mt-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand-orange px-4 text-sm font-bold text-white shadow-sm transition hover:bg-brand-orange-dark active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <LogIn className="h-4 w-4" />
              <span>{submitting ? 'Memeriksa...' : 'Masuk'}</span>
            </button>
          </form>
        </div>

        {appVersion && (
          <p className="mt-4 text-center font-mono text-[11px] font-medium text-brand-brown/50">
            NotaDigital {appVersion}
          </p>
        )}
      </div>
    </div>
  );
}
