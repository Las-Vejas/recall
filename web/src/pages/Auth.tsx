import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api, type Me, type ProviderRef } from '../api';
import { Logo } from '../App';
import { IconGitHub, IconGoogle, IconPasskey, IconShield } from '../components/Icons';

const query = () => new URLSearchParams(window.location.search);

/** Turns WebAuthn's DOMExceptions into something a person can act on. */
export function passkeyErrorMessage(e: unknown): string {
  const err = e as { name?: string; message?: string };
  if (err?.name === 'NotAllowedError') return 'The passkey prompt was closed or timed out.';
  if (err?.name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  if (err?.name === 'SecurityError') return 'Passkeys need HTTPS (or localhost) and the right address. Check PUBLIC_URL.';
  return err?.message || 'Something went wrong with the passkey.';
}

export function ProviderIcon({ type, size = 18 }: { type: string; size?: number }) {
  if (type === 'github') return <IconGitHub size={size} />;
  if (type === 'google') return <IconGoogle size={size} />;
  return <IconShield size={size} />;
}

function ProviderButtons({ providers, inviteToken, verb = 'Continue' }: { providers: ProviderRef[]; inviteToken?: string; verb?: string }) {
  if (!providers.length) return null;
  return (
    <div className="grid" style={{ gap: 8 }}>
      {providers.map((p) => (
        <a key={p.id} className="btn lg provider-btn" href={`/api/auth/oauth/${p.id}/start${inviteToken ? `?invite=${encodeURIComponent(inviteToken)}` : ''}`}>
          <ProviderIcon type={p.type} /> {verb} with {p.name}
        </a>
      ))}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="login-wrap">
      <motion.div className="login-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 28 }}>
        {children}
      </motion.div>
    </div>
  );
}
const Divider = ({ label = 'or' }: { label?: string }) => <div className="or"><span>{label}</span></div>;
const ErrorLine = ({ msg }: { msg: string }) => (msg ? <div className="form-error">{msg}</div> : null);

export function LoginPage({ me, onDone }: { me: Me; onDone: () => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState(query().get('error') || '');
  const [busy, setBusy] = useState<'' | 'passkey' | 'password'>('');
  const [showPassword, setShowPassword] = useState(!me.passkeys && !me.providers.length);
  const canPasskey = me.passkeys && browserSupportsWebAuthn();

  useEffect(() => { if (query().get('error')) window.history.replaceState(null, '', '/login'); }, []);

  const passkey = async () => {
    setErr(''); setBusy('passkey');
    try {
      const optionsJSON = await api.passkeyLoginOptions();
      const response = await startAuthentication({ optionsJSON: optionsJSON as never });
      await api.loginPasskey(response);
      onDone();
    } catch (e) { setErr(passkeyErrorMessage(e)); }
    finally { setBusy(''); }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(''); setBusy('password');
    try { await api.loginPassword(login, password); onDone(); }
    catch (x) { setErr((x as Error).message); }
    finally { setBusy(''); }
  };

  return (
    <Card>
      <Logo />
      <div>
        <h2 style={{ fontSize: 22 }}>Sign in</h2>
        <p className="muted" style={{ margin: '4px 0 0' }}>Welcome back. Pick up where you left off.</p>
      </div>
      {canPasskey && (
        <button className="btn primary lg" onClick={passkey} disabled={!!busy}>
          <IconPasskey /> {busy === 'passkey' ? 'Waiting for your passkey…' : 'Sign in with a passkey'}
        </button>
      )}
      <ProviderButtons providers={me.providers} />
      {(canPasskey || me.providers.length > 0) && <Divider />}
      {showPassword ? (
        <form className="grid" style={{ gap: 10 }} onSubmit={submit}>
          <input className="input" autoComplete="username" placeholder="Username or email" value={login} onChange={(e) => setLogin(e.target.value)} autoFocus={!canPasskey} />
          <input className="input" type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className={`btn lg ${canPasskey ? '' : 'primary'}`} disabled={!login || !password || !!busy}>{busy === 'password' ? 'Signing in…' : 'Sign in with password'}</button>
        </form>
      ) : (
        <button className="btn ghost" onClick={() => setShowPassword(true)}>Use a password instead</button>
      )}
      <ErrorLine msg={err} />
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>
        New here? Ask the person who runs this Recall for an invite link.{me.openSignup && <> Or <a href="/join" style={{ color: 'var(--accent-2)' }}>create an account</a>.</>}
      </p>
    </Card>
  );
}

function AccountForm({ submitLabel, needPassword, minPassword, onSubmit, extra }: {
  submitLabel: string; needPassword: boolean; minPassword: number; extra?: React.ReactNode;
  onSubmit: (v: { name: string; username: string; email: string; password: string }) => Promise<void>;
}) {
  const [v, setV] = useState({ name: '', username: '', email: '', password: '' });
  const [touchedUser, setTouchedUser] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setV((s) => {
      const next = { ...s, [k]: val };
      // suggest a username from the name until the person edits it
      if (k === 'name' && !touchedUser) next.username = val.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 24);
      return next;
    });
    if (k === 'username') setTouchedUser(true);
  };
  const short = v.password.length > 0 && v.password.length < minPassword;
  return (
    <form className="grid" style={{ gap: 10 }} onSubmit={async (e) => {
      e.preventDefault(); setErr(''); setBusy(true);
      try { await onSubmit(v); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
    }}>
      <input className="input" placeholder="Your name" autoComplete="name" value={v.name} onChange={set('name')} autoFocus />
      <div className="input-prefix"><span>@</span><input className="input" placeholder="username" autoComplete="username" value={v.username} onChange={set('username')} /></div>
      <input className="input" type="email" placeholder="Email" autoComplete="email" value={v.email} onChange={set('email')} />
      <input className="input" type="password" autoComplete="new-password" value={v.password} onChange={set('password')}
        placeholder={needPassword ? `Password (${minPassword}+ characters)` : 'Password (optional, keeps your current one if blank)'} />
      {short && <div className="faint" style={{ fontSize: 13 }}>At least {minPassword} characters.</div>}
      {extra}
      <ErrorLine msg={err} />
      <button className="btn primary lg" disabled={busy || !v.name.trim() || !v.username || !v.email || (needPassword && v.password.length < minPassword) || short}>{busy ? 'One moment…' : submitLabel}</button>
    </form>
  );
}

export function ClaimPage({ token, me, onDone }: { token: string; me: Me; onDone: () => void }) {
  const [info, setInfo] = useState<{ valid: boolean; legacyPassword: boolean } | null>(null);
  useEffect(() => { api.claimInfo(token).then(setInfo).catch(() => setInfo({ valid: false, legacyPassword: false })); }, [token]);
  if (!info) return null;
  if (!info.valid) {
    return (
      <Card>
        <Logo />
        <h2 style={{ fontSize: 22 }}>This claim link doesn't work</h2>
        <p className="muted" style={{ margin: 0 }}>It was already used, has expired, or this Recall is already set up. To get a new one, run this where Recall runs:</p>
        <pre className="code-block" style={{ margin: 0 }}>node server/cli.js claim</pre>
        <a className="btn" href="/login">Go to sign in</a>
      </Card>
    );
  }
  return (
    <Card>
      <Logo />
      <div>
        <span className="pill due" style={{ marginBottom: 10 }}><IconShield size={14} /> Superadmin</span>
        <h2 style={{ fontSize: 22, marginTop: 8 }}>Claim this Recall</h2>
        <p className="muted" style={{ margin: '4px 0 0' }}>
          You're creating the first account. It can invite people, add sign-in providers and manage the instance.
          {info.legacyPassword && ' Decks already on this server move into your account.'}
        </p>
      </div>
      <AccountForm submitLabel="Claim and continue" needPassword={!info.legacyPassword} minPassword={me.minPassword}
        onSubmit={async (v) => { await api.claim(token, { ...v, password: v.password || undefined }); window.history.replaceState(null, '', '/account/security?welcome=1'); onDone(); }} />
    </Card>
  );
}

export function InvitePage({ token, me, onDone }: { token: string | null; me: Me; onDone: () => void }) {
  const [info, setInfo] = useState<{ valid: boolean; isAdmin: boolean } | null>(token ? null : { valid: me.openSignup, isAdmin: false });
  useEffect(() => { if (token) api.inviteInfo(token).then(setInfo).catch(() => setInfo({ valid: false, isAdmin: false })); }, [token]);
  if (!info) return null;
  if (!info.valid) {
    return (
      <Card>
        <Logo />
        <h2 style={{ fontSize: 22 }}>{token ? 'This invite has expired' : 'Sign-up is invite-only'}</h2>
        <p className="muted" style={{ margin: 0 }}>{token ? 'Invites work once and last 7 days. Ask for a new one.' : 'Ask the person who runs this Recall for an invite link.'}</p>
        <a className="btn" href="/login">Go to sign in</a>
      </Card>
    );
  }
  return (
    <Card>
      <Logo />
      <div>
        <h2 style={{ fontSize: 22 }}>{token ? "You're invited" : 'Create your account'}</h2>
        <p className="muted" style={{ margin: '4px 0 0' }}>Make an account to build and study your own decks.{info.isAdmin && ' You will be a superadmin.'}</p>
      </div>
      <ProviderButtons providers={me.providers} inviteToken={token || undefined} verb="Sign up" />
      {me.providers.length > 0 && <Divider label="or with a password" />}
      <AccountForm submitLabel="Create account" needPassword minPassword={me.minPassword}
        onSubmit={async (v) => { await api.register({ ...v, inviteToken: token || undefined }); window.history.replaceState(null, '', '/account/security?welcome=1'); onDone(); }} />
    </Card>
  );
}
