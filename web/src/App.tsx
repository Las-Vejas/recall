import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter, Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { api, type Deck, type Folder, type Me } from './api';
import { folderPath, folderSummary } from './folders';
import { IconDecks, IconFolder, IconImport, IconLogout, IconMenu, IconMoon, IconPlay, IconSearch, IconSun, IconClose, IconKey } from './components/Icons';
import Home from './pages/Home';
import DeckPage from './pages/Deck';
import Study from './pages/Study';
import ImportPage from './pages/Import';
import Login from './pages/Login';

export function Logo({ withName = true }: { withName?: boolean }) {
  return (
    <div className="side-brand">
      <div className="brand-mark">
        <svg width="16" height="16" viewBox="0 0 32 32" fill="none">
          <path d="M9 24V8h8a5 5 0 0 1 0 10h-5l8 6" stroke="white" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      {withName && <span>Recall</span>}
    </div>
  );
}

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

type Theme = 'system' | 'light' | 'dark';
function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try { return (localStorage.getItem('recall-theme') as Theme) || 'system'; } catch { return 'system'; }
  });
  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('recall-theme', theme); } catch { /* private mode */ }
  }, [theme]);
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return { isDark, toggle: () => setTheme(isDark ? 'light' : 'dark') };
}

function CommandPalette({ decks, folders, onClose }: { decks: Deck[]; folders: Folder[]; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const items = useMemo(() => {
    const all = [
      { key: 'study', label: 'Study everything due', path: '', go: '/study/all', icon: <IconPlay /> },
      { key: 'import', label: 'Import Anki deck', path: '', go: '/import', icon: <IconImport /> },
      ...folders.map((f) => ({ key: `f${f.id}`, label: f.name, path: folderPath(folders, f.parent_id).map((p) => p.name).join(' › '), go: `/folder/${f.id}`, icon: <IconFolder /> })),
      ...decks.map((d) => ({ key: `d${d.id}`, label: d.name, path: folderPath(folders, d.folder_id).map((p) => p.name).join(' › '), go: `/deck/${d.id}`, icon: <span className="dot" style={{ background: d.color, borderRadius: 3, width: 10, height: 10 }} /> })),
    ];
    const s = q.trim().toLowerCase();
    return s ? all.filter((i) => `${i.path} ${i.label}`.toLowerCase().includes(s)) : all;
  }, [q, decks, folders]);
  const go = (i: number) => { const it = items[i]; if (it) { onClose(); nav(it.go); } };
  return (
    <div className="overlay" onClick={onClose}>
      <motion.div className="palette" initial={{ opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus placeholder="Jump to a deck, folder or action…" value={q}
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

function ChangePasswordModal({ minPassword, onClose }: { minPassword: number; onClose: () => void }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="overlay" onClick={onClose}>
      <motion.form className="modal" style={{ maxWidth: 420 }} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
        onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}
        onSubmit={async (e) => {
          e.preventDefault();
          try { await api.changePassword(cur, next); setMsg({ ok: true, text: 'Password changed. Other devices have been signed out.' }); setCur(''); setNext(''); }
          catch (x) { setMsg({ ok: false, text: (x as Error).message }); }
        }}>
        <h2>Change password</h2>
        <div className="grid">
          <input className="input" type="password" autoFocus autoComplete="current-password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} />
          <input className="input" type="password" autoComplete="new-password" placeholder={`New password (${minPassword}+ characters)`} value={next} onChange={(e) => setNext(e.target.value)} />
          {msg && <div style={{ color: msg.ok ? 'var(--good)' : 'var(--again)', fontSize: 14 }}>{msg.text}</div>}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn ghost" onClick={onClose}>{msg?.ok ? 'Done' : 'Cancel'}</button>
            <button className="btn primary" disabled={!cur || next.length < minPassword}>Change</button>
          </div>
        </div>
      </motion.form>
    </div>
  );
}

function Sidebar({ open, onClose, onSearch, me, onLogout }: {
  open: boolean; onClose: () => void; onSearch: () => void; me: Me; onLogout: () => void;
}) {
  const [pwModal, setPwModal] = useState(false);
  const loc = useLocation();
  const { decks, folders } = useLibrary();
  const { isDark, toggle } = useTheme();
  const due = decks.reduce((a, d) => a + d.counts.new + d.counts.learn + d.counts.review, 0);
  const rootFolders = folders.filter((f) => f.parent_id == null);
  const active = (re: RegExp) => (re.test(loc.pathname) ? 'side-item active' : 'side-item');
  useEffect(onClose, [loc.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <Link to="/" style={{ flex: 1 }}><Logo /></Link>
        {open && <button className="icon-btn" onClick={onClose} aria-label="Close menu"><IconClose /></button>}
      </div>
      <div className="side-search" onClick={onSearch} role="button">
        <IconSearch size={16} /><span>Search</span><kbd>⌘K</kbd>
      </div>
      <div className="side-label">Library</div>
      <Link className={active(/^\/($|deck\/)/)} to="/"><IconDecks /> Decks</Link>
      <Link className="side-item" to="/study/all"><IconPlay /> Study all {due > 0 && <span className="badge">{due}</span>}</Link>
      <Link className={active(/^\/import/)} to="/import"><IconImport /> Import</Link>
      {rootFolders.length > 0 && <div className="side-label">Folders</div>}
      <div className="side-folders">
        {rootFolders.map((f) => {
          const n = folderSummary(folders, decks, f.id).counts;
          const fdue = n.new + n.learn + n.review;
          return (
            <Link key={f.id} className={active(new RegExp(`^/folder/${f.id}$`))} to={`/folder/${f.id}`}>
              <IconFolder /> <span className="name">{f.name}</span>
              {fdue > 0 && <span className="badge" style={{ background: 'var(--bg-2)', color: 'var(--muted)' }}>{fdue}</span>}
            </Link>
          );
        })}
      </div>
      <div className="side-foot">
        <span className="who">{me.passwordRequired ? 'signed in' : 'no login'}</span>
        <button className="icon-btn" onClick={toggle} title={isDark ? 'Light mode' : 'Dark mode'}>{isDark ? <IconSun /> : <IconMoon />}</button>
        {me.mode === 'stored' && <button className="icon-btn" onClick={() => setPwModal(true)} title="Change password"><IconKey /></button>}
        {me.passwordRequired && <button className="icon-btn" onClick={onLogout} title="Log out"><IconLogout /></button>}
      </div>
      {pwModal && <ChangePasswordModal minPassword={me.minPassword} onClose={() => setPwModal(false)} />}
    </aside>
  );
}

function Shell({ children, me, onLogout }: { children: React.ReactNode; me: Me; onLogout: () => void }) {
  const loc = useLocation();
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  const lib = useLibrary();
  const closeMenu = useCallback(() => setMenu(false), []);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
      if (e.key === '/' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement) && !document.querySelector('.overlay')) { e.preventDefault(); setPalette(true); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  if (loc.pathname.startsWith('/study')) return <>{children}</>;
  return (
    <div className="app">
      <Sidebar open={menu} onClose={closeMenu} onSearch={() => setPalette(true)} me={me} onLogout={onLogout} />
      <main className="main" ref={mainRef}>
        <div className="mobile-bar">
          <button className="icon-btn" onClick={() => setMenu(true)} aria-label="Menu"><IconMenu /></button>
          <Link to="/"><Logo /></Link>
          <span className="spacer" />
          <button className="icon-btn" onClick={() => setPalette(true)} aria-label="Search"><IconSearch /></button>
        </div>
        <div className="page">{children}</div>
      </main>
      {palette && <CommandPalette decks={lib.decks} folders={lib.folders} onClose={() => setPalette(false)} />}
    </div>
  );
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
  if (!me.authed) return <Login setup={me.needsSetup} minPassword={me.minPassword} onDone={refresh} />;

  return (
    <BrowserRouter>
      <Shell me={me} onLogout={async () => { await api.logout(); refresh(); }}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/folder/:folderId" element={<Home key="folder" />} />
          <Route path="/deck/:id" element={<DeckPage />} />
          <Route path="/study/:deck" element={<Study />} />
          <Route path="/import" element={<ImportPage />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  );
}
