'use client';

/**
 * Login / signup page (cookie-session auth, AUTH_MODE=jwt).
 *
 * Same-origin POSTs to /connect-auth/v1/login|signup — the API sets the
 * HttpOnly session cookies itself; on success we hard-navigate to '/' so the
 * app boots with a fresh whoami. Logout redirects land here (HOSTS.LOGIN_URL).
 */

import { useEffect, useState } from 'react';
import { Button } from '@ui/src';
import { Eye, EyeOff } from 'lucide-react';
import { VaartaLogoLottie } from '@/shared-components/vaarta-logo-lottie';
import { setAppBranding } from '@/config/app-branding';

type Mode = 'login' | 'signup';

type SsoProvider = {
  id: string;
  type: 'oidc' | 'oauth2';
  display_name: string;
  login_url: string;
};

type AuthModeInfo = {
  mode: 'dev' | 'jwt' | 'sso' | 'oidc';
  allow_password_login: boolean;
  allow_signup: boolean;
  login_url: string;
  logout_url?: string | null;
  oidc_enabled?: boolean;
  oidc_login_url?: string | null;
  oidc_display_name?: string;
  // one button per configured provider (AUTH_PROVIDERS)
  providers?: SsoProvider[];
  app_name?: string;
  app_mode?: 'general' | 'medical';
};

const FIELD_CLS =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm ' +
  'outline-none focus:ring-2 focus:ring-ring focus:border-transparent';

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [authInfo, setAuthInfo] = useState<AuthModeInfo | null>(null);

  useEffect(() => {
    fetch('/connect-auth/v1/auth-mode')
      .then((r) => r.json())
      .then((info: AuthModeInfo) => {
        setAppBranding(info);
        try {
          // the logout flow reads this to finish sign-out at the IdP
          sessionStorage.setItem('scribe-auth-mode', JSON.stringify(info));
        } catch (_) {
          // storage unavailable — logout falls back to the login page
        }
        const target = info?.login_url;
        // Never bounce to ourselves: a backend still reporting the password
        // login_url would otherwise reload this page forever.
        const selfReferential =
          !target ||
          target === window.location.pathname ||
          target.startsWith(window.location.pathname + '?');
        // Straight to the provider only when this page has nothing to offer:
        // no password form AND no SSO button to click.
        const hasOnPageOption =
          info?.allow_password_login !== false || Boolean(info?.oidc_enabled);
        if (!hasOnPageOption && !selfReferential) {
          window.location.replace(target as string);
          return;
        }
        setAuthInfo(info);
      })
      .catch(() => setAuthInfo(null)); // offline/unknown: keep the password form
  }, []);

  const passwordAllowed = authInfo?.allow_password_login !== false;
  const signupAllowed = passwordAllowed && authInfo?.allow_signup !== false;
  // Every configured provider gets a button (number of AUTH_PROVIDERS entries
  // == number of buttons). Older backends without `providers` fall back to
  // the single default-provider fields.
  const ssoProviders: SsoProvider[] =
    authInfo?.providers && authInfo.providers.length > 0
      ? authInfo.providers
      : authInfo?.oidc_enabled && authInfo.oidc_login_url
        ? [
            {
              id: 'default',
              type: 'oidc',
              display_name: authInfo.oidc_display_name || 'Single sign-on',
              login_url: authInfo.oidc_login_url,
            },
          ]
        : [];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const body: Record<string, string> = { username: username.trim(), password };
      if (mode === 'signup' && displayName.trim()) body.display_name = displayName.trim();

      const res = await fetch(`/connect-auth/v1/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'client-id': 'doc-web' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data?.status === 'success') {
        // ?next= lets flows like /auth/activate (desktop sign-in approval)
        // resume after login. Relative paths only — never an absolute URL.
        const next = new URLSearchParams(window.location.search).get('next') || '';
        const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
        window.location.href = safeNext;
        return;
      }
      setError(
        data?.error?.message ||
          data?.message ||
          (mode === 'login' ? 'Invalid username or password' : 'Signup failed')
      );
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen w-full flex-1 items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-xl border border-muted-foreground bg-card p-8 shadow-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <VaartaLogoLottie />
          <p className="mt-4 text-2xl text-black">
            {!passwordAllowed
              ? 'Sign in to continue'
              : mode === 'login'
                ? 'Sign in to continue'
                : 'Create your account'}
          </p>
        </div>

        {/* SSO first: Parichay (or any configured provider) is the primary
            path; username/password is the secondary fallback below. */}
        {ssoProviders.length > 0 && (
          <>
            <div className="flex flex-col gap-2">
              {ssoProviders.map((p) => (
                <div key={p.id} className="flex items-center gap-3">
                  {/parichay/i.test(p.display_name) && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src="/assets/parichay-logo.png"
                      alt="Parichay"
                      className="h-7 w-auto shrink-0"
                    />
                  )}
                  <Button
                    type="button"
                    className="flex-1"
                    onClick={() => {
                      // full navigation (not fetch): the IdP round-trip is a
                      // top-level redirect and must set cookies on the way back
                      window.location.href = p.login_url;
                    }}
                  >
                    Login with {p.display_name}
                  </Button>
                </div>
              ))}
            </div>
            {passwordAllowed && (
              <div className="my-5 flex items-center gap-3">
                <span className="h-px flex-1 bg-border" />
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  or
                </span>
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
          </>
        )}

        {passwordAllowed && (
          <form onSubmit={submit} className="flex flex-col gap-3">
          {mode === 'signup' && (
            <input
              className={FIELD_CLS}
              placeholder="Display name (optional)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              autoComplete="name"
            />
          )}
          <input
            className={FIELD_CLS}
            placeholder="Username or email"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            minLength={3}
          />
          <div className="relative">
            <input
              className={`${FIELD_CLS} pr-10`}
              type={showPassword ? 'text' : 'password'}
              placeholder={mode === 'signup' ? 'Password (min 8 characters)' : 'Password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'signup' ? 8 : 1}
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              className="absolute inset-y-0 right-0 flex cursor-pointer items-center px-3 text-muted-foreground hover:text-foreground"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button
            type="submit"
            variant="outline"
            disabled={submitting || !username || !password}
            className="mt-1 w-full"
          >
            {submitting ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
          </form>
        )}

        <p className="mt-5 text-center text-sm text-muted-foreground">
          {mode === 'login' && !signupAllowed ? null : mode === 'login' ? (
            <>
              New here?{' '}
              <button
                type="button"
                className="cursor-pointer font-medium text-primary hover:underline"
                onClick={() => {
                  setMode('signup');
                  setError('');
                }}
              >
                Create an account
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                type="button"
                className="cursor-pointer font-medium text-primary hover:underline"
                onClick={() => {
                  setMode('login');
                  setError('');
                }}
              >
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
