import { useCallback, useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { api, timeAgo, type AdminUser, type Invite, type Provider, displayName } from '../api';
import { useSession } from '../App';
import Avatar from '../components/Avatar';
import { SettingsLayout, SCard, SRow, Notice } from '../components/Settings';
import { ProviderIcon } from './Auth';
import { useCopy } from '../components/ui/Toast';
import { Modal } from '../components/ui/Modal';
import { IconCheck, IconCopy, IconMail, IconPlus, IconShield, IconTrash, IconPencil } from '../components/Icons';

function Overview() {
  const [o, setO] = useState<Awaited<ReturnType<typeof api.adminOverview>> | null>(null);
  useEffect(() => { api.adminOverview().then(setO); }, []);
  if (!o) return null;
  const items: [boolean, string, string][] = [
    [o.checklist.https, 'Served over HTTPS', 'Passkeys and secure cookies need HTTPS. Put Recall behind a reverse proxy or a tunnel.'],
    [o.checklist.publicUrl, 'PUBLIC_URL is set', `Passkeys and provider callbacks use this address. Right now Recall guesses ${o.origin}.`],
    [o.checklist.passkey, 'You have a passkey', 'Keep at least one passkey on the superadmin account so a broken provider never locks you out.'],
    [o.checklist.provider, 'A sign-in provider is set up', 'Optional: let people sign in with GitHub, Google or your own OpenID Connect provider.'],
    [o.checklist.postgres, 'Data in Postgres', `Optional: ${o.database}. Postgres (DATABASE_URL) makes backups and restarts worry-free.`],
  ];
  return (
    <>
      <div className="grid stats">
        {Object.entries(o.counts).map(([k, v]) => (
          <div key={k} className="panel stat"><div className="label">{k[0].toUpperCase() + k.slice(1)}</div><div className="value">{v.toLocaleString()}</div></div>
        ))}
      </div>
      <SCard title="Setup checklist">
        {items.map(([done, title, sub]) => (
          <SRow key={title} icon={<span className={`check ${done ? 'done' : ''}`}>{done ? <IconCheck size={14} /> : null}</span>} title={title} sub={done ? undefined : sub} />
        ))}
      </SCard>
    </>
  );
}

function Users() {
  const { user: me } = useSession();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [err, setErr] = useState('');
  const load = useCallback(() => { api.adminUsers().then(setUsers); }, []);
  useEffect(load, [load]);
  return (
    <>
      {err && <Notice kind="error" onClose={() => setErr('')}>{err}</Notice>}
      <SCard title="Users" desc="Each person has their own private library.">
        {users.map((u) => (
          <SRow key={u.id} icon={<Avatar name={u.name} username={u.username} size={32} />}
            title={<>{displayName(u)} {u.is_admin ? <span className="pill due" style={{ height: 22, fontSize: 12 }}>Admin</span> : null} {u.id === me.id && <span className="faint" style={{ fontSize: 13 }}>(you)</span>}</>}
            sub={`@${u.username} · ${u.email} · ${u.decks} deck${u.decks === 1 ? '' : 's'} · ${u.passkeys} passkey${u.passkeys === 1 ? '' : 's'} · last sign-in ${timeAgo(u.last_login_at)}`}>
            {u.id !== me.id && (
              <>
                <button className="btn ghost sm" onClick={async () => {
                  if (!u.is_admin && !confirm(`Make @${u.username} a superadmin? They can manage every account on this Recall.`)) return;
                  try { await api.adminUpdateUser(u.id, { isAdmin: !u.is_admin }); load(); } catch (e) { setErr((e as Error).message); }
                }}>{u.is_admin ? 'Remove admin' : 'Make admin'}</button>
                <button className="btn ghost sm danger" title="Delete user" aria-label={`Delete @${u.username}`} onClick={async () => {
                  if (!confirm(`Delete @${u.username} and all of their decks, cards and history? This cannot be undone.`)) return;
                  try { await api.adminDeleteUser(u.id); load(); } catch (e) { setErr((e as Error).message); }
                }}><IconTrash size={15} /></button>
              </>
            )}
          </SRow>
        ))}
      </SCard>
    </>
  );
}

function Invites() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [note, setNote] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [fresh, setFresh] = useState('');
  const { toast, copy } = useCopy();
  const load = useCallback(() => { api.invites().then(setInvites); }, []);
  useEffect(load, [load]);
  const status = (i: Invite) => (i.used_at ? `Used by @${i.used_by_username || 'deleted user'} ${timeAgo(i.used_at)}` : i.expires_at < Date.now() ? 'Expired' : `Expires ${new Date(i.expires_at).toLocaleDateString()}`);
  return (
    <>
      <SCard title="Invite someone" desc="Recall has no email, so invites are links you send yourself. Each link works once and lasts 7 days.">
        <form className="row" style={{ padding: '0 18px 14px', flexWrap: 'wrap' }} onSubmit={async (e) => {
          e.preventDefault(); const r = await api.createInvite({ note, isAdmin }); setFresh(r.url); setNote(''); setIsAdmin(false); load(); copy(r.url, 'Invite link copied');
        }}>
          <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Who is it for? (only you see this)" value={note} onChange={(e) => setNote(e.target.value)} />
          <label className="row" style={{ gap: 6, fontSize: 14 }}><input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> Superadmin</label>
          <button className="btn primary">Create link</button>
        </form>
        {fresh && (
          <div className="fresh-token">
            <code>{fresh}</code>
            <button className="btn sm" onClick={() => copy(fresh, 'Invite link copied')}><IconCopy size={14} /> Copy</button>
          </div>
        )}
      </SCard>
      <SCard title="Invites">
        {invites.map((i) => (
          <SRow key={i.id} icon={<IconMail />} title={<>{i.note || 'Invite'} {i.is_admin ? <span className="pill due" style={{ height: 22, fontSize: 12 }}>Admin</span> : null}</>} sub={`Created ${timeAgo(i.created_at)} · ${status(i)}`}>
            {!i.used_at && <button className="btn ghost sm danger" onClick={async () => { await api.deleteInvite(i.id); load(); }}>Revoke</button>}
          </SRow>
        ))}
        {!invites.length && <div className="s-empty">No invites yet.</div>}
      </SCard>
      {toast}
    </>
  );
}

const TYPE_INFO: Record<string, { label: string; help: string; console: string }> = {
  github: { label: 'GitHub', help: 'Create an OAuth App at GitHub → Settings → Developer settings → OAuth Apps.', console: 'https://github.com/settings/applications/new' },
  google: { label: 'Google', help: 'Create an OAuth client (Web application) in Google Cloud → APIs & Services → Credentials.', console: 'https://console.cloud.google.com/apis/credentials' },
  oidc: { label: 'OpenID Connect', help: 'Any provider with discovery: Authentik, Keycloak, Okta, Auth0, Entra ID, GitLab, Hack Club…', console: '' },
};

function ProviderForm({ existing, callbackBase, onClose, onSaved }: { existing?: Provider; callbackBase: string; onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState<Provider['type']>(existing?.type || 'github');
  const [v, setV] = useState({ name: existing?.name || '', issuer: existing?.issuer || '', clientId: existing?.clientId || '', clientSecret: '', scopes: existing?.scopes || '', allowSignup: existing?.allowSignup ?? false, enabled: existing?.enabled ?? true });
  const [err, setErr] = useState('');
  const { toast, copy } = useCopy();
  const previewId = existing?.id || (type === 'oidc' ? (v.name || 'oidc').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : type);
  const cb = existing?.callbackUrl || `${callbackBase}/${previewId}/callback`;
  return (
    <Modal title={existing ? `Edit ${existing.name}` : 'Add a sign-in provider'} width={560} onClose={onClose}
      onSubmit={async () => { try { await api.saveProvider({ ...v, type }, existing?.id); onSaved(); onClose(); } catch (x) { setErr((x as Error).message); } }}>
        <div className="grid">
          {!existing && (
            <div className="tabs" style={{ marginBottom: 0 }}>
              {Object.entries(TYPE_INFO).map(([t, i]) => <button type="button" key={t} className={type === t ? 'on' : ''} onClick={() => setType(t as Provider['type'])}>{i.label}</button>)}
            </div>
          )}
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>{TYPE_INFO[type].help} {TYPE_INFO[type].console && <a href={TYPE_INFO[type].console} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-2)' }}>Open console ↗</a>}</p>
          <label className="field">Redirect URL (give this to the provider)
            <div className="row"><code className="input" style={{ overflow: 'auto', whiteSpace: 'nowrap' }}>{cb}</code><button type="button" className="btn sm" onClick={() => copy(cb)} aria-label="Copy redirect URL"><IconCopy size={14} /></button></div>
          </label>
          {(type === 'oidc' || existing) && <label className="field">Display name<input className="input" placeholder={TYPE_INFO[type].label} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></label>}
          {type === 'oidc' && <label className="field">Issuer URL<input className="input" placeholder="https://auth.example.com/application/o/recall" value={v.issuer} onChange={(e) => setV({ ...v, issuer: e.target.value })} /></label>}
          <label className="field">Client ID<input className="input" value={v.clientId} onChange={(e) => setV({ ...v, clientId: e.target.value })} /></label>
          <label className="field">Client secret<input className="input" type="password" placeholder={existing?.hasSecret ? 'Unchanged (leave blank to keep)' : ''} value={v.clientSecret} onChange={(e) => setV({ ...v, clientSecret: e.target.value })} autoComplete="off" /></label>
          <label className="row" style={{ gap: 8, fontSize: 14 }}><input type="checkbox" checked={v.allowSignup} onChange={(e) => setV({ ...v, allowSignup: e.target.checked })} />
            Create accounts on first sign-in <span className="faint">(only with an invite, or when open sign-up is on)</span></label>
          <label className="row" style={{ gap: 8, fontSize: 14 }}><input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> Show on the sign-in page</label>
          {err && <div className="form-error">{err}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary">{existing ? 'Save' : 'Add provider'}</button>
          </div>
        </div>
      {toast}
    </Modal>
  );
}

function SignIn() {
  const [s, setS] = useState<Awaited<ReturnType<typeof api.signinSettings>> | null>(null);
  const [editing, setEditing] = useState<Provider | 'new' | null>(null);
  const load = useCallback(() => { api.signinSettings().then(setS); }, []);
  useEffect(load, [load]);
  if (!s) return null;
  return (
    <>
      <SCard title="Who can join" desc={s.openSignup ? 'Anyone who finds this Recall can create an account.' : 'Only people with an invite link can create an account.'}
        action={<label className="switch"><input type="checkbox" checked={s.openSignup} onChange={async (e) => { await api.setOpenSignup(e.target.checked); load(); }} /><span /> <span style={{ fontSize: 14 }}>Open sign-up</span></label>} />
      <SCard title="Sign-in providers" desc="Let people sign in with an account they already have. Passkeys and passwords always work too."
        action={<button className="btn primary sm" onClick={() => setEditing('new')}><IconPlus size={15} /> Add provider</button>}>
        {s.providers.map((p) => (
          <SRow key={p.id} icon={<ProviderIcon type={p.type} />}
            title={<>{p.name} {!p.enabled && <span className="pill" style={{ height: 22, fontSize: 12 }}>Hidden</span>} {p.fromEnv && <span className="pill" style={{ height: 22, fontSize: 12 }}>Set by the environment</span>}</>}
            sub={`${p.type === 'oidc' ? p.issuer : p.type} · ${p.allowSignup ? 'creates accounts on first sign-in' : 'existing accounts only'}`}>
            {!p.fromEnv && <button className="btn ghost sm" onClick={() => setEditing(p)}><IconPencil size={14} /> Edit</button>}
            {!p.fromEnv && <button className="btn ghost sm danger" aria-label={`Remove ${p.name}`} title="Remove provider" onClick={async () => { if (confirm(`Remove ${p.name}? People who only sign in with it will need another method.`)) { await api.deleteProvider(p.id); load(); } }}><IconTrash size={15} /></button>}
          </SRow>
        ))}
        {!s.providers.length && <div className="s-empty">No providers yet.</div>}
      </SCard>
      {editing && <ProviderForm existing={editing === 'new' ? undefined : editing} callbackBase={s.callbackBase} onClose={() => setEditing(null)} onSaved={load} />}
    </>
  );
}

export default function AdminPage() {
  const { user } = useSession();
  const { section = 'overview' } = useParams();
  if (!user.isAdmin) return <Navigate to="/" replace />;
  return (
    <SettingsLayout
      crumb="Instance admin"
      header={(
        <section className="profile-card">
          <span className="admin-mark"><IconShield size={30} /></span>
          <h1 style={{ flex: 1 }}>Instance admin</h1>
        </section>
      )}
      nav={[
        { label: 'Instance', items: [{ to: '/admin', label: 'Overview' }] },
        { label: 'People', items: [{ to: '/admin/users', label: 'Users' }, { to: '/admin/invites', label: 'Invites' }, { to: '/admin/signin', label: 'Sign in' }] },
      ]}
    >
      {section === 'overview' && <Overview />}
      {section === 'users' && <Users />}
      {section === 'invites' && <Invites />}
      {section === 'signin' && <SignIn />}
      {!['overview', 'users', 'invites', 'signin'].includes(section) && <Navigate to="/admin" replace />}
    </SettingsLayout>
  );
}
