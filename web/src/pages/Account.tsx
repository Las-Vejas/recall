import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api, timeAgo, deviceName, type ApiToken, type Device, type Identity, type Passkey, type ProviderRef } from '../api';
import { useSession } from '../App';
import { ACCENTS, setAccent, setTheme, useAccent, useTheme, type Theme } from '../theme';
import { agentPrompt } from '../agentPrompt';
import Avatar from '../components/Avatar';
import { SettingsLayout, SCard, SRow, Notice } from '../components/Settings';
import { passkeyErrorMessage, ProviderIcon } from './Auth';
import { useCopy } from '../components/ui/Toast';
import { Modal } from '../components/ui/Modal';
import { ask } from '../components/ui/ask';
import StudySettingsPage from './StudySettings';
import { IconPasskey, IconMonitor, IconEye, IconEyeOff, IconPencil, IconKey, IconCopy, IconSun, IconMoon } from '../components/Icons';

const params = () => new URLSearchParams(window.location.search);
function maskEmail(e: string) { const [u, d] = e.split('@'); return `${u.slice(0, 2)}${'•'.repeat(Math.max(2, Math.min(4, u.length - 2)))}@${d}`; }

function EditProfile({ onClose }: { onClose: () => void }) {
  const { user, refresh } = useSession();
  const [v, setV] = useState({ name: user.name, username: user.username, email: user.email });
  const [err, setErr] = useState('');
  return (
    <Modal title="Edit profile" width={440} onClose={onClose}
      onSubmit={async () => { try { await api.updateAccount(v); refresh(); onClose(); } catch (x) { setErr((x as Error).message); } }}>
        <div className="grid">
          <label className="field">Name<input className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} autoFocus /></label>
          <label className="field">Username<div className="input-prefix"><span>@</span><input className="input" value={v.username} onChange={(e) => setV({ ...v, username: e.target.value })} /></div></label>
          <label className="field">Email<input className="input" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></label>
          {err && <div className="form-error">{err}</div>}
          <div className="row justify-end">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary">Save</button>
          </div>
        </div>
    </Modal>
  );
}

function Header({ counts }: { counts: { passkeys: number; devices: number; identities: number } | null }) {
  const { user } = useSession();
  const [reveal, setReveal] = useState(false);
  const [edit, setEdit] = useState(false);
  const [providers, setProviders] = useState<string[]>([]);
  useEffect(() => { api.identities().then((r) => setProviders([...new Set(r.linked.map((l) => l.providerName))])).catch(() => {}); }, [counts]);
  return (
    <section className="profile-card">
      <Avatar name={user.name} username={user.username} size={84} />
      <div className="grow min-w-0">
        <h1>{user.name || user.username}</h1>
        <div className="profile-facts">
          <span className="mono">{user.username}</span>
          <span className="row" style={{ gap: 6 }}>
            {reveal ? user.email : maskEmail(user.email)}
            <button className="icon-btn tiny" onClick={() => setReveal((r) => !r)} title={reveal ? 'Hide email' : 'Show email'}>{reveal ? <IconEyeOff size={15} /> : <IconEye size={15} />}</button>
          </span>
          {counts && <span>{counts.passkeys} passkey{counts.passkeys === 1 ? '' : 's'}</span>}
          {counts && <span>{counts.devices} device{counts.devices === 1 ? '' : 's'}</span>}
          {providers.map((p) => <span key={p}>{p} connected</span>)}
          {user.isAdmin && <span className="pill due" style={{ height: 24 }}>Superadmin</span>}
        </div>
      </div>
      <button className="btn" onClick={() => setEdit(true)}><IconPencil size={15} /> Edit</button>
      {edit && <EditProfile onClose={() => setEdit(false)} />}
    </section>
  );
}

// ---------------- sections ----------------
function Connections() {
  const [data, setData] = useState<{ linked: Identity[]; providers: ProviderRef[] } | null>(null);
  const [err, setErr] = useState(params().get('error') || '');
  const [ok, setOk] = useState(params().get('connected') ? `${params().get('connected')} is connected. You can now sign in with it.` : '');
  const load = useCallback(() => { api.identities().then(setData); }, []);
  useEffect(() => { load(); if (window.location.search) window.history.replaceState(null, '', window.location.pathname); }, [load]);
  if (!data) return null;
  const linkedIds = new Set(data.linked.map((l) => l.provider));
  const available = data.providers.filter((p) => !linkedIds.has(p.id));
  return (
    <>
      {ok && <Notice kind="ok" onClose={() => setOk('')}>{ok}</Notice>}
      {err && <Notice kind="error" onClose={() => setErr('')}>{err}</Notice>}
      <SCard title="Sign-in providers" desc="Connect an account from a provider to sign in with it.">
        {data.linked.map((l) => (
          <SRow key={l.id} icon={<ProviderIcon type={l.providerType} />} title={l.username ? `@${l.username}` : l.email || l.providerName} sub={`${l.providerName} · connected ${timeAgo(l.created_at)}`}>
            <button className="btn ghost sm" onClick={async () => { try { await api.disconnect(l.id); load(); } catch (e) { setErr((e as Error).message); } }}>Disconnect</button>
          </SRow>
        ))}
        {available.map((p) => (
          <SRow key={p.id} icon={<ProviderIcon type={p.type} />} title={p.name} sub="Not connected">
            <a className="btn sm" href={`/api/auth/oauth/${p.id}/start?mode=link`}>Connect</a>
          </SRow>
        ))}
        {!data.providers.length && <div className="s-empty">No sign-in providers are set up on this Recall yet. A superadmin can add GitHub, Google or any OpenID Connect provider in Instance admin.</div>}
      </SCard>
    </>
  );
}

function Tokens() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState('');
  const { toast, copy } = useCopy();
  const load = useCallback(() => { api.tokens().then(setTokens); }, []);
  useEffect(load, [load]);
  const origin = window.location.origin;
  return (
    <>
      <SCard title="API tokens" desc="Let scripts and AI agents use your library. A token can list decks and import them; over MCP it can also search cards and study. It can't edit or delete anything.">
        <form className="row" style={{ padding: '0 18px 14px' }} onSubmit={async (e) => {
          e.preventDefault();
          const r = await api.createApiToken(name || 'Token'); setFresh(r.token); setName(''); load();
        }}>
          <input className="input" placeholder="Token name, e.g. Claude agent" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn primary">Create token</button>
        </form>
        {fresh && (
          <div className="fresh-token">
            <code>{fresh}</code>
            <button className="btn sm" onClick={() => copy(fresh, 'Token copied')}><IconCopy size={14} /> Copy</button>
            <div className="faint" style={{ width: '100%', fontSize: 13, color: 'var(--hard)' }}>Copy it now. It won't be shown again.</div>
          </div>
        )}
        {tokens.map((t) => (
          <SRow key={t.id} icon={<IconKey />} title={t.name} sub={`Created ${timeAgo(t.created_at)} · last used ${timeAgo(t.last_used_at)}`}>
            <button className="btn ghost sm danger" onClick={async () => { if (await ask({ title: `Revoke “${t.name}”?`, body: 'Anything using this token stops working.', confirm: 'Revoke', danger: true })) { await api.deleteApiToken(t.id); load(); } }}>Revoke</button>
          </SRow>
        ))}
        {!tokens.length && !fresh && <div className="s-empty">No tokens yet.</div>}
      </SCard>
      <SCard title="Use with an AI agent" desc="Paste these instructions into your assistant. It will write decks in Recall's JSON format and post them with your token."
        action={<button className="btn sm" onClick={() => copy(agentPrompt(origin, true), 'Instructions copied')}><IconCopy size={14} /> Copy instructions</button>}>
        <pre className="code-block" style={{ margin: '0 18px 18px' }}>{`curl -X POST ${origin}/api/import/json \\\n  -H "Authorization: Bearer $RECALL_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  --data @deck.json`}</pre>
      </SCard>
      <McpCard token={fresh} origin={origin} copy={copy} />
      {toast}
    </>
  );
}

/** Connection details for MCP clients (Claude, Cursor, VS Code…). Fills in a token that was just created. */
function McpCard({ token, origin, copy }: { token: string; origin: string; copy: (text: string, label: string) => void }) {
  const url = `${origin}/mcp`;
  const tok = token || 'YOUR_TOKEN';
  const cli = `claude mcp add --transport http recall ${url} \\\n  --header "Authorization: Bearer ${tok}"`;
  const json = JSON.stringify({ mcpServers: { recall: { type: 'http', url, headers: { Authorization: `Bearer ${tok}` } } } }, null, 2);
  return (
    <SCard title="Connect over MCP" desc={`Add Recall as an MCP server so your assistant can create decks, search cards and quiz you. Use a token from above${token ? ' (filled in below)' : ''}.`}
      action={<button className="btn sm" onClick={() => copy(url, 'MCP address copied')}><IconCopy size={14} /> Copy address</button>}>
      <div style={{ padding: '0 18px 18px', display: 'grid', gap: 10 }}>
        <div className="row justify-between">
          <span className="faint text-sm">Claude Code</span>
          <button className="btn ghost sm" onClick={() => copy(cli.replace(/\\\n\s*/g, ''), 'Command copied')}><IconCopy size={14} /> Copy</button>
        </div>
        <pre className="code-block m-0">{cli}</pre>
        <div className="row justify-between">
          <span className="faint text-sm">Cursor and other clients that read an mcp.json</span>
          <button className="btn ghost sm" onClick={() => copy(json, 'Config copied')}><IconCopy size={14} /> Copy</button>
        </div>
        <pre className="code-block m-0">{json}</pre>
      </div>
    </SCard>
  );
}

function Security() {
  const { user, me, refresh } = useSession();
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(
    params().get('welcome') ? { kind: 'info', text: 'Welcome. Add a passkey so you can sign in with Touch ID, Face ID, Windows Hello or a security key.' } : null,
  );
  const [pw, setPw] = useState({ current: '', next: '' });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api.passkeys().then(setPasskeys); api.devices().then(setDevices); }, []);
  useEffect(() => { load(); if (window.location.search) window.history.replaceState(null, '', window.location.pathname); }, [load]);
  const canPasskey = me.passkeys && browserSupportsWebAuthn();

  const addPasskey = async () => {
    setBusy(true); setMsg(null);
    try {
      const optionsJSON = await api.passkeyRegisterOptions();
      const response = await startRegistration({ optionsJSON: optionsJSON as never });
      setPasskeys(await api.addPasskey(response, ''));
      setMsg({ kind: 'ok', text: 'Passkey added. You can use it to sign in from now on.' });
    } catch (e) { setMsg({ kind: 'error', text: passkeyErrorMessage(e) }); }
    finally { setBusy(false); }
  };

  return (
    <>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}
      <SCard title="Passkeys" desc="Sign in with Touch ID, Face ID, Windows Hello or a hardware key. A passkey only works on this site, so phishing pages can't use it."
        action={<button className="btn primary sm" onClick={addPasskey} disabled={!canPasskey || busy} title={canPasskey ? '' : 'Passkeys need HTTPS'}><IconPasskey size={15} /> {busy ? 'Waiting…' : 'Add passkey'}</button>}>
        {passkeys.map((p) => (
          <SRow key={p.id} icon={<IconPasskey />} title={p.name} sub={`Added ${timeAgo(p.created_at)} · last used ${timeAgo(p.last_used_at)}`}>
            <button className="btn ghost sm" onClick={async () => { const n = prompt('Name this passkey', p.name); if (n) { await api.renamePasskey(p.id, n); load(); } }}>Rename</button>
            <button className="btn ghost sm danger" onClick={async () => {
              if (!(await ask({ title: `Remove “${p.name}”?`, body: 'You won’t be able to sign in with this passkey any more.', confirm: 'Remove', danger: true }))) return;
              try { await api.removePasskey(p.id); load(); } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
            }}>Remove</button>
          </SRow>
        ))}
        {!passkeys.length && <div className="s-empty">{canPasskey ? 'No passkeys yet. Add one, and add a second on another device so you never get locked out.' : 'Passkeys need this site to be served over HTTPS.'}</div>}
      </SCard>

      <SCard title="Devices" desc="Everywhere you're signed in. Sessions last 30 days after the last visit."
        action={devices.length > 1 && <button className="btn sm" onClick={async () => {
          if (await ask({ title: 'Sign out every other device?', body: 'This also deletes your API tokens.', confirm: 'Sign out others', danger: true })) { await api.signOutOthers(); load(); setMsg({ kind: 'ok', text: 'Signed out of every other device.' }); }
        }}>Sign out others</button>}>
        {devices.map((d) => (
          <SRow key={d.id} icon={<IconMonitor />} title={<>{deviceName(d.user_agent)} {d.current && <span className="pill ok sm">This device</span>}</>}
            sub={`${d.method || 'Signed in'} · ${d.ip || 'unknown IP'} · active ${timeAgo(d.last_seen_at)}`}>
            {!d.current && <button className="btn ghost sm" onClick={async () => { await api.signOutDevice(d.id); load(); }}>Sign out</button>}
          </SRow>
        ))}
      </SCard>

      <SCard title="Password" desc={user.hasPassword ? 'You can sign in with your username or email and this password.' : "You don't have a password. That's fine if you use passkeys or a provider."}>
        <form className="grid" style={{ gap: 10, padding: '0 18px 18px', maxWidth: 420 }} onSubmit={async (e) => {
          e.preventDefault(); setMsg(null);
          try { await api.setPassword(pw.current, pw.next); setPw({ current: '', next: '' }); refresh(); setMsg({ kind: 'ok', text: user.hasPassword ? 'Password changed.' : 'Password set.' }); }
          catch (x) { setMsg({ kind: 'error', text: (x as Error).message }); }
        }}>
          {user.hasPassword && <input className="input" type="password" placeholder="Current password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />}
          <input className="input" type="password" placeholder={`New password (${me.minPassword}+ characters)`} autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <div className="row">
            <button className="btn" disabled={pw.next.length < me.minPassword}>{user.hasPassword ? 'Change password' : 'Set password'}</button>
            {user.hasPassword && <button type="button" className="btn ghost danger" onClick={async () => {
              if (!(await ask({ title: 'Remove your password?', body: 'You’ll sign in with a passkey or a sign-in provider instead.', confirm: 'Remove password', danger: true }))) return;
              try { await api.removePassword(); refresh(); setMsg({ kind: 'ok', text: 'Password removed.' }); } catch (x) { setMsg({ kind: 'error', text: (x as Error).message }); }
            }}>Remove password</button>}
          </div>
        </form>
      </SCard>
    </>
  );
}

function Appearance() {
  const theme = useTheme();
  const accent = useAccent();
  const opts: { v: Theme; label: string; icon: React.ReactNode }[] = [
    { v: 'light', label: 'Light', icon: <IconSun /> }, { v: 'dark', label: 'Dark', icon: <IconMoon /> }, { v: 'system', label: 'System', icon: <IconMonitor /> },
  ];
  return (
    <>
      <SCard title="Colour" desc="Colour and mode are saved on this device.">
        <div className="accent-picks" role="radiogroup" aria-label="Colour theme">
          {ACCENTS.map((a) => (
            <button key={a.id} data-accent={a.id} role="radio" aria-checked={accent === a.id}
              className={`accent-pick ${accent === a.id ? 'on' : ''}`} onClick={() => setAccent(a.id)}>
              <span className="preview"><i /><b /></span>
              <span className="label"><span className="dot" />{a.name}</span>
            </button>
          ))}
        </div>
      </SCard>
      <SCard title="Mode">
        <div className="theme-picks">
          {opts.map((o) => (
            <button key={o.v} className={`theme-pick ${theme === o.v ? 'on' : ''}`} onClick={() => setTheme(o.v)}>
              <span className={`theme-swatch ${o.v}`} />
              <span className="row gap-2">{o.icon}{o.label}</span>
            </button>
          ))}
        </div>
      </SCard>
    </>
  );
}

function YourData() {
  return (
    <>
      <SCard title="Download everything" desc="Every folder, deck, card, review and image you have, as a zip. The cards keep their scheduling, so nothing is lost.">
        <div className="s-pad"><a className="btn" href="/api/account/export" download>Download my data (.zip)</a></div>
      </SCard>
      <SCard title="Move decks to Anki" desc="All your decks as one Anki package, with scheduling and review history. Anki keeps your folders as nested decks.">
        <div className="s-pad row wrap">
          <a className="btn" href="/api/export/all?format=apkg" download>All decks (.apkg)</a>
          <a className="btn ghost" href="/api/export/all?format=json" download>All decks (Recall JSON)</a>
        </div>
      </SCard>
    </>
  );
}

export default function AccountPage() {
  const { section } = useParams();
  const nav = useNavigate();
  const [counts, setCounts] = useState<{ passkeys: number; devices: number; identities: number } | null>(null);
  useEffect(() => { api.account().then((a) => setCounts(a.counts)); }, [section]);
  // /account opens Connections, like Orchard
  useEffect(() => { if (!section || !['connections', 'tokens', 'security', 'appearance', 'study', 'data'].includes(section)) nav(`/account/connections${window.location.search}`, { replace: true }); }, [section, nav]);
  return (
    <SettingsLayout
      crumb="Account"
      header={<Header counts={counts} />}
      nav={[
        { label: 'Connections', items: [{ to: '/account/connections', label: 'Connections' }, { to: '/account/tokens', label: 'API tokens' }] },
        { label: 'Security', items: [{ to: '/account/security', label: 'Passkeys and devices' }] },
        { label: 'Preferences', items: [{ to: '/account/study', label: 'Study' }, { to: '/account/appearance', label: 'Appearance' }] },
        { label: 'Data', items: [{ to: '/account/data', label: 'Export' }] },
      ]}
    >
      {section === 'connections' && <Connections />}
      {section === 'tokens' && <Tokens />}
      {section === 'security' && <Security />}
      {section === 'appearance' && <Appearance />}
      {section === 'study' && <StudySettingsPage />}
      {section === 'data' && <YourData />}
    </SettingsLayout>
  );
}
