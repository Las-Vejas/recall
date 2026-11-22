import { useState } from 'react';
import { motion } from 'motion/react';
import { api } from '../api';
import { Logo } from '../App';

/** Login screen, or (on a fresh install) the first-run "choose a password" screen. */
export default function Login({ setup, minPassword, onDone }: { setup: boolean; minPassword: number; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    if (setup && pw !== pw2) return setErr("Passwords don't match");
    setBusy(true);
    try {
      if (setup) await api.setup(pw);
      else await api.login(pw);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tooShort = setup && pw.length < minPassword;

  return (
    <div className="login-wrap">
      <motion.form
        onSubmit={submit}
        className="login-card"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0, x: err ? [0, -8, 8, -4, 4, 0] : 0 }}
        transition={{ x: { duration: 0.35 } }}
      >
        <Logo />
        {setup ? (
          <div>
            <h2 style={{ fontSize: 22 }}>Welcome to Recall</h2>
            <p className="muted" style={{ margin: '6px 0 0' }}>Choose a password for this server. You'll use it to sign in from any device.</p>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>This Recall instance is private. Enter the password to continue.</p>
        )}
        <input className="input" type="password" autoFocus autoComplete={setup ? 'new-password' : 'current-password'}
          placeholder={setup ? `New password (${minPassword}+ characters)` : 'Password'} value={pw} onChange={(e) => setPw(e.target.value)} />
        {setup && (
          <input className="input" type="password" autoComplete="new-password" placeholder="Repeat password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        )}
        {err && <div style={{ color: 'var(--again)', fontSize: 14 }}>{err}</div>}
        <button className="btn primary lg" disabled={busy || !pw || tooShort || (setup && !pw2)}>{setup ? 'Set password & start' : 'Unlock'}</button>
      </motion.form>
    </div>
  );
}
