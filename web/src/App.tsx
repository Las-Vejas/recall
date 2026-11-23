import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { api, displayName, type Deck, type Folder, type Me, type User } from './api';
import { folderPath, folderSummary } from './folders';
import { setTheme, useTheme } from './theme';
import Avatar from './components/Avatar';
import Mesh from './components/Mesh';
import {
  IconDecks, IconChart, IconFolder, IconImport, IconLogout, IconMenu, IconMoon, IconPlay, IconSearch, IconSun, IconClose, IconKey,
  IconGear, IconPalette, IconShield, IconSidebar, IconMonitor,
} from './components/Icons';
import Home from './pages/Home';
import DeckPage from './pages/Deck';
import Study from './pages/Study';
import ImportPage from './pages/Import';
import InsightsPage from './pages/Insights';
import AccountPage from './pages/Account';
import AdminPage from './pages/Admin';
import { LoginPage, ClaimPage, InvitePage, ConsentPage } from './pages/Auth';

/** The Recall mark (a flashcard with an R, another fanned out behind it), drawn on the theme gradient. Same shape as scripts/build-icons.mjs. */
export function LogoMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <g transform="translate(32 32) scale(1.08) translate(-30.5 -32.5)">
        <rect x="14" y="16" width="28" height="34" rx="6" fill="#fff" opacity=".42" transform="rotate(-10 28 33)" />
        <rect x="21" y="15.5" width="28" height="35" rx="6" fill="#000" opacity=".14" />
        <rect x="21" y="14" width="28" height="35" rx="6" fill="#fff" />
        <path d="M29 41V24h7a5 5 0 0 1 0 10h-4l7 7" fill="none" stroke="var(--logo-ink)" strokeWidth="4.4" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

export function Logo({ withName = true }: { withName?: boolean }) {
  return (
    <div className="side-brand">
      <div className="brand-mark"><LogoMark /></div>
      {withName && <span>Recall</span>}
    </div>
  );
}

/** The signed-in person, available everywhere; `refresh` re-reads it after profile changes. */
const SessionCtx = createContext<{ user: User; me: Me; refresh: () => void; signOut: () => void } | null>(null);
export const useSession = () => useContext(SessionCtx)!;

/** Library data shared by the sidebar and command palette; refreshed on every navigation. */
function useLibrary() {
  const loc = useLocation();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // pages fire this after changing the library without navigating (e.g. an import)
    const bump = () => setTick((t) => t + 1);
    window.addEventListener('recall:library-changed', bump);
    return () => window.removeEventListener('recall:library-changed', bump);
  }, []);
  useEffect(() => {
    api.decks().then(setDecks).catch(() => {});
    api.folders().then(setFolders).catch(() => {});
  }, [loc.pathname, tick]);
  return { decks, folders };
}

function CommandPalette({ decks, folders, isAdmin, onClose }: { decks: Deck[]; folders: Folder[]; isAdmin: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const items = useMemo(() => {
    const all = [
      { key: 'study', label: 'Study everything due', path: '', go: '/study/all', icon: <IconPlay /> },
      { key: 'insights', label: 'Insights', path: '', go: '/insights', icon: <IconChart /> },
      { key: 'import', label: 'Import decks', path: '', go: '/import', icon: <IconImport /> },
      { key: 'account', label: 'Account settings', path: '', go: '/account', icon: <IconGear /> },
      { key: 'passkeys', label: 'Passkeys and devices', path: 'Account', go: '/account/security', icon: <IconKey /> },
      ...(isAdmin ? [{ key: 'admin', label: 'Instance admin', path: '', go: '/admin', icon: <IconShield /> }] : []),
      ...folders.map((f) => ({ key: `f${f.id}`, label: f.name, path: folderPath(folders, f.parent_id).map((p) => p.name).join(' › '), go: `/folder/${f.id}`, icon: <IconFolder /> })),
      ...decks.map((d) => ({ key: `d${d.id}`, label: d.name, path: folderPath(folders, d.folder_id).map((p) => p.name).join(' › '), go: `/deck/${d.id}`, icon: <span className="dot" style={{ background: d.color, borderRadius: 3, width: 10, height: 10 }} /> })),
    ];
    const s = q.trim().toLowerCase();
    return s ? all.filter((i) => `${i.path} ${i.label}`.toLowerCase().includes(s)) : all;
  }, [q, decks, folders, isAdmin]);
  const go = (i: number) => { const it = items[i]; if (it) { onClose(); nav(it.go); } };
  return (
    <div className="overlay" onClick={onClose}>
      <motion.div className="palette" initial={{ opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus placeholder="Jump to a deck, folder, setting…" value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            if (e.key === 'Enter') go(sel);
          }}
        />
        <div className="results">
          {items.length === 0 && <div className="faint" style={{ padding: 14 }}>No matches</div>}
          {items.map((it, i) => (
            <div key={it.key} className={`item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => go(i)}>
              <span className="muted" style={{ display: 'grid', placeItems: 'center', width: 20 }}>{it.icon}</span>
              <span>{it.label}</span>
              {it.path && <span className="path">{it.path}</span>}
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

function ThemeSwitch() {
  const theme = useTheme();
  const opts = [['light', <IconSun size={16} key="l" />, 'Light'], ['dark', <IconMoon size={16} key="d" />, 'Dark'], ['system', <IconMonitor size={16} key="s" />, 'System']] as const;
  return (
    <div className="segmented" role="radiogroup" aria-label="Theme">
      {opts.map(([v, icon, label]) => (
        <button key={v} role="radio" aria-checked={theme === v} className={theme === v ? 'on' : ''} onClick={() => setTheme(v)} title={label}>{icon}</button>
      ))}
    </div>
  );
}

/** The account menu that opens from the bottom of the sidebar, like Orchard's. */
function UserMenu({ onClose }: { onClose: () => void }) {
  const { user, signOut } = useSession();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => document.addEventListener('mousedown', h));
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [onClose]);
  return (
    <motion.div ref={ref} className="user-menu" initial={{ opacity: 0, y: 6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6 }} transition={{ duration: 0.14 }}>
      <div className="um-head">
        <Avatar name={user.name} username={user.username} size={38} />
        <div style={{ minWidth: 0 }}>
          <div className="um-name">{displayName(user)}</div>
          <div className="um-email">{user.email}</div>
        </div>
      </div>
      <div className="um-row"><span>Theme</span><ThemeSwitch /></div>
      <div className="um-sep" />
      <Link className="um-item" to="/account" onClick={onClose}><IconGear size={17} /> Account settings</Link>
      <Link className="um-item" to="/account/appearance" onClick={onClose}><IconPalette size={17} /> Appearance</Link>
      <Link className="um-item" to="/account/tokens" onClick={onClose}><IconKey size={17} /> API tokens</Link>
      {user.isAdmin && (
        <>
          <div className="um-sep" />
          <Link className="um-item" to="/admin" onClick={onClose}><IconShield size={17} /> Instance admin</Link>
        </>
      )}
      <div className="um-sep" />
      <button className="um-item danger" onClick={signOut}><IconLogout size={17} /> Sign out</button>
    </motion.div>
  );
}

function Sidebar({ open, collapsed, onToggleCollapse, onClose, onSearch }: {
  open: boolean; collapsed: boolean; onToggleCollapse: () => void; onClose: () => void; onSearch: () => void;
}) {
  const loc = useLocation();
  const { user } = useSession();
  const { decks, folders } = useLibrary();
  const [menu, setMenu] = useState(false);
  const due = decks.reduce((a, d) => a + d.counts.new + d.counts.learn + d.counts.review, 0);
  const rootFolders = folders.filter((f) => f.parent_id == null);
  const cls = (re: RegExp) => (re.test(loc.pathname) ? 'side-item active' : 'side-item');
  useEffect(onClose, [loc.pathname]); // eslint-disable-line react-hooks/exhaustive-deps
  const tip = (label: string) => (collapsed ? { title: label } : {});

  return (
    <aside className={`sidebar ${open ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`}>
      <div className="side-head">
        <Link to="/" className="side-switch" {...tip('Recall')}>
          <Logo withName={false} />
          {!collapsed && <span className="side-title">Recall</span>}
        </Link>
        {open && <button className="icon-btn" onClick={onClose} aria-label="Close menu"><IconClose /></button>}
      </div>
      {collapsed ? (
        <button className="side-item" onClick={onSearch} title="Search (⌘K)"><IconSearch /></button>
      ) : (
        <div className="side-search" onClick={onSearch} role="button"><IconSearch size={16} /><span>Search</span><kbd>⌘K</kbd></div>
      )}
      <Link className={cls(/^\/($|deck\/)/)} to="/" {...tip('Decks')}><IconDecks /> <span className="name">Decks</span></Link>
      <Link className="side-item" to="/study/all" {...tip('Study all')}><IconPlay /> <span className="name">Study all</span>{due > 0 && <span className="badge">{due}</span>}</Link>
      <Link className={cls(/^\/insights/)} to="/insights" {...tip('Insights')}><IconChart /> <span className="name">Insights</span></Link>
      <Link className={cls(/^\/import/)} to="/import" {...tip('Import')}><IconImport /> <span className="name">Import</span></Link>
      {!collapsed && rootFolders.length > 0 && <div className="side-label">Folders</div>}
      <div className="side-folders">
        {!collapsed && rootFolders.map((f) => {
          const n = folderSummary(folders, decks, f.id).counts;
          const fdue = n.new + n.learn + n.review;
          return (
            <Link key={f.id} className={cls(new RegExp(`^/folder/${f.id}$`))} to={`/folder/${f.id}`}>
              <IconFolder /> <span className="name">{f.name}</span>
              {fdue > 0 && <span className="badge quiet">{fdue}</span>}
            </Link>
          );
        })}
      </div>
      <div className="side-foot">
        <button className="side-user" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu} title={collapsed ? displayName(user) : undefined}>
          <Avatar name={user.name} username={user.username} size={28} />
          {!collapsed && <span className="who">{displayName(user)}</span>}
        </button>
        {!collapsed && <button className="icon-btn" onClick={onToggleCollapse} title="Collapse sidebar"><IconSidebar size={17} /></button>}
        <AnimatePresence>{menu && <UserMenu onClose={() => setMenu(false)} />}</AnimatePresence>
      </div>
      {collapsed && <button className="side-item" onClick={onToggleCollapse} title="Expand sidebar"><IconSidebar /></button>}
    </aside>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const { user } = useSession();
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('recall-sidebar') === 'collapsed'; } catch { return false; } });
  const lib = useLibrary();
  const closeMenu = useCallback(() => setMenu(false), []);
  const toggleCollapse = () => setCollapsed((c) => { try { localStorage.setItem('recall-sidebar', c ? 'open' : 'collapsed'); } catch { /* ignore */ } return !c; });

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
      if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); toggleCollapse(); }
      if (e.key === '/' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement) && !document.querySelector('.overlay')) { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  if (loc.pathname.startsWith('/study')) return <>{children}</>;
  return (
    <div className={`app ${collapsed ? 'is-collapsed' : ''}`}>
      <Sidebar open={menu} collapsed={collapsed && !menu} onToggleCollapse={toggleCollapse} onClose={closeMenu} onSearch={() => setPalette(true)} />
      <main className="main">
        <div className="mobile-bar">
          <button className="icon-btn" onClick={() => setMenu(true)} aria-label="Menu"><IconMenu /></button>
          <Link to="/"><Logo /></Link>
          <span className="spacer" />
          <button className="icon-btn" onClick={() => setPalette(true)} aria-label="Search"><IconSearch /></button>
        </div>
        <div className="page">{children}</div>
      </main>
      {palette && <CommandPalette decks={lib.decks} folders={lib.folders} isAdmin={user.isAdmin} onClose={() => setPalette(false)} />}
    </div>
  );
}

/** Pages shown to people who aren't signed in. */
function SignedOut({ me, refresh }: { me: Me; refresh: () => void }) {
  const path = window.location.pathname;
  const claim = /^\/claim\/([\w-]+)/.exec(path)?.[1];
  const invite = /^\/invite\/([\w-]+)/.exec(path)?.[1];
  if (claim) return <ClaimPage token={claim} me={me} onDone={refresh} />;
  if (invite) return <InvitePage token={invite} me={me} onDone={refresh} />;
  if (path === '/join') return <InvitePage token={null} me={me} onDone={refresh} />;
  if (me.needsClaim) {
    return (
      <div className="login-wrap">
        <Mesh />
        <div className="login-card">
          <Logo />
          <h2 style={{ fontSize: 22 }}>This Recall hasn't been claimed yet</h2>
          <p className="muted" style={{ margin: 0 }}>The first account is created with the claim link printed in the server logs when Recall starts. To print a new one, run:</p>
          <pre className="code-block" style={{ margin: 0 }}>node server/cli.js claim</pre>
        </div>
      </div>
    );
  }
  // come back to the consent page after signing in, even through an identity provider's redirect
  if (path === '/oauth/authorize') { try { sessionStorage.setItem('recall-return', path + window.location.search); } catch { /* storage off */ } }
  if (path !== '/login') window.history.replaceState(null, '', path === '/oauth/authorize' ? '/login' : `/login${window.location.search}`);
  return <LoginPage me={me} onDone={refresh} />;
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const refresh = useCallback(() => { api.me().then(setMe).catch(() => setMe(null)); }, []);

  useEffect(() => {
    refresh();
    window.addEventListener('recall:unauthorized', refresh);
    return () => window.removeEventListener('recall:unauthorized', refresh);
  }, [refresh]);

  if (!me) return null;
  if (!me.user) return <SignedOut me={me} refresh={refresh} />;
  let back: string | null = null;
  try { back = sessionStorage.getItem('recall-return'); sessionStorage.removeItem('recall-return'); } catch { /* storage off */ }
  if (back?.startsWith('/oauth/authorize')) window.history.replaceState(null, '', back);
  if (/^\/(login|claim|invite|join)/.test(window.location.pathname)) window.history.replaceState(null, '', '/');

  const signOut = async () => { await api.logout(); window.history.replaceState(null, '', '/login'); refresh(); };
  if (window.location.pathname === '/oauth/authorize') {
    return <ConsentPage me={me} onSignOut={async () => {
      try { sessionStorage.setItem('recall-return', window.location.pathname + window.location.search); } catch { /* storage off */ }
      await api.logout(); window.history.replaceState(null, '', '/login'); refresh();
    }} />;
  }
  return (
    <SessionCtx.Provider value={{ user: me.user, me, refresh, signOut }}>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/folder/:folderId" element={<Home key="folder" />} />
            <Route path="/deck/:id" element={<DeckPage />} />
            <Route path="/study/:deck" element={<Study />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/insights" element={<InsightsPage />} />
            <Route path="/account/:section?" element={<AccountPage />} />
            <Route path="/admin/:section?" element={<AdminPage />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </SessionCtx.Provider>
  );
}
