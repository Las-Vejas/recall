import { useCallback, useEffect, useState } from 'react';
import Mesh from '../components/Mesh';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { api, fmtDuration, fmtInterval, type Deck, type Folder, type Stats, type Counts } from '../api';
import { Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { Heatmap, Forecast } from '../components/Charts';
import { folderPath, folderSummary, subtree } from '../folders';
import { ask } from '../components/ui/ask';
import { CustomStudy } from '../components/CustomStudy';
import { IconFolder, IconSearch, IconGear, IconFlame } from '../components/Icons';

export function CountChips({ c }: { c: Counts }) {
  return (
    <div className="counts">
      <span className={`chip new ${c.new ? '' : 'zero'}`} title="New">{c.new}</span>
      <span className={`chip learn ${c.learn ? '' : 'zero'}`} title="Learning">{c.learn}</span>
      <span className={`chip review ${c.review ? '' : 'zero'}`} title="Review">{c.review}</span>
    </div>
  );
}

const COLORS = ['#e5484d', '#ff7a45', '#f5a524', '#3dd68c', '#22c3a6', '#52a9ff', '#8e6cff', '#ff6b9a'];
const dueOf = (c: Counts) => c.new + c.learn + c.review;

/** Small modal with one text field: used for new deck / new folder / rename. */
function NameModal({ title, initial = '', withColor, onClose, onSubmit }: {
  title: string; initial?: string; withColor?: boolean; onClose: () => void; onSubmit: (name: string, color: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [color, setColor] = useState(COLORS[Math.floor(Math.random() * COLORS.length)]);
  const [err, setErr] = useState('');
  return (
    <Modal title={title} width={420} onClose={onClose}
      onSubmit={async () => { try { await onSubmit(name.trim(), color); } catch (x) { setErr((x as Error).message); } }}>
        <div className="grid">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.target.select()} />
          {withColor && (
            <div className="row gap-2">
              {COLORS.map((c) => (
                <button type="button" key={c} onClick={() => setColor(c)} aria-label={`Colour ${c}`}
                  style={{ width: 26, height: 26, borderRadius: 8, background: c, border: 'none', cursor: 'pointer', boxShadow: color === c ? '0 0 0 2px var(--surface), 0 0 0 4px var(--text)' : 'none' }} />
              ))}
            </div>
          )}
          {err && <div style={{ color: 'var(--again)', fontSize: 14 }}>{err}</div>}
          <div className="row justify-end">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!name.trim()}>Save</button>
          </div>
        </div>
    </Modal>
  );
}

type DragItem = { kind: 'deck' | 'folder'; id: number };
const DRAG_MIME = 'application/x-recall';

/** Native drag & drop: decks and folders can be dropped onto folders or breadcrumbs. */
function useDropTarget(folderId: number | null, onDrop: (item: DragItem, folderId: number | null) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes(DRAG_MIME)) { e.preventDefault(); setOver(true); } },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        setOver(false);
        const raw = e.dataTransfer.getData(DRAG_MIME);
        if (raw) { e.preventDefault(); onDrop(JSON.parse(raw), folderId); }
      },
    },
  };
}
const dragProps = (item: DragItem) => ({
  draggable: true,
  onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData(DRAG_MIME, JSON.stringify(item)); e.dataTransfer.effectAllowed = 'move'; },
});

function Crumb({ folder, onDrop, last }: { folder: Folder | null; onDrop: (i: DragItem, f: number | null) => void; last: boolean }) {
  const { over, props } = useDropTarget(folder?.id ?? null, onDrop);
  const label = folder ? folder.name : 'Home';
  return (
    <span {...props} className={`crumb ${over ? 'over' : ''}`}>
      {last ? <span>{label}</span> : <Link to={folder ? `/folder/${folder.id}` : '/'}>{label}</Link>}
    </span>
  );
}

/** A whole row that opens something: clickable, reachable with Tab, opens on Enter. (Not an <a>, because it holds a Study button.) */
const rowLink = (open: () => void) => ({
  role: 'link', tabIndex: 0, onClick: open,
  onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); e.stopPropagation(); open(); } },
});

function FolderRow({ folder, folders, decks, onDrop }: { folder: Folder; folders: Folder[]; decks: Deck[]; onDrop: (i: DragItem, f: number | null) => void }) {
  const nav = useNavigate();
  const sum = folderSummary(folders, decks, folder.id);
  const subfolders = folders.filter((f) => f.parent_id === folder.id).length;
  const { over, props } = useDropTarget(folder.id, onDrop);
  const due = dueOf(sum.counts);
  return (
    <div className={`list-row ${over ? 'drop-over' : ''} ${due ? '' : 'caught-up'}`} {...dragProps({ kind: 'folder', id: folder.id })} {...props} {...rowLink(() => nav(`/folder/${folder.id}`))}>
      <div className="tile"><IconFolder /><span className={`dot ${due ? 'due' : 'ok'}`} /></div>
      <div className="body">
        <div className="title">{folder.name}</div>
        <div className="sub">{sum.decks} deck{sum.decks === 1 ? '' : 's'}{subfolders ? ` · ${subfolders} folder${subfolders === 1 ? '' : 's'}` : ''} · {sum.cards} cards</div>
      </div>
      <div className="end">
        <CountChips c={sum.counts} />
        {due > 0 && <button className="btn sm" onClick={(e) => { e.stopPropagation(); nav(`/study/f${folder.id}`); }}>Study</button>}
      </div>
    </div>
  );
}

function DeckRow({ d }: { d: Deck }) {
  const nav = useNavigate();
  const due = dueOf(d.counts);
  const mastery = d.total ? Math.round((d.mature / d.total) * 100) : 0;
  return (
    <div className={`list-row ${due ? '' : 'caught-up'}`} {...dragProps({ kind: 'deck', id: d.id })} {...rowLink(() => nav(`/deck/${d.id}`))}>
      <div className="tile"><span className="swatch" style={{ background: d.color }} /><span className={`dot ${due ? 'due' : 'ok'}`} /></div>
      <div className="body">
        <div className="title">{d.name}</div>
        <div className="sub">{d.total} cards · {mastery}% mature{d.description ? ` · ${d.description}` : ''}</div>
      </div>
      <div className="end">
        <CountChips c={d.counts} />
        {due > 0 && <button className="btn sm" onClick={(e) => { e.stopPropagation(); nav(`/study/${d.id}`); }}>Study</button>}
      </div>
    </div>
  );
}

function SidePanels({ stats }: { stats: Stats }) {
  const nextDue = stats.forecast.filter((f) => f.day > 0).sort((a, b) => a.day - b.day)[0];
  return (
    <div className="side-col">
      <div className="panel">
        <div className="panel-head"><h3>Today</h3><span className="faint">{new Date().toLocaleDateString(undefined, { weekday: 'long' })}</span></div>
        <div className="kv">
          <div><div className="label">Reviewed</div><div className="value">{stats.today.reviews}<small>{stats.today.ms ? fmtDuration(stats.today.ms) : ''}</small></div></div>
          <div><div className="label">Streak</div><div className="value" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{stats.streak}<small>day{stats.streak === 1 ? '' : 's'}</small>{stats.streak > 1 && <span style={{ color: 'var(--hard)', marginLeft: 2 }}><IconFlame size={16} /></span>}</div></div>
          <div style={{ gridColumn: '1 / -1' }}>
            <div className="row"><span className="label">Retention · 30 days</span><span className="spacer" /><span className="mono text-sm">{stats.retention == null ? '—' : `${Math.round(stats.retention * 100)}%`}</span></div>
            <div className="meter"><div style={{ width: `${(stats.retention ?? 0) * 100}%`, background: 'var(--good)' }} /></div>
          </div>
        </div>
      </div>
      <div className="panel">
        <div className="panel-head"><h3>Coming up</h3><span className="faint">{nextDue ? `next in ${fmtInterval(nextDue.day * 86_400_000)}` : '30 days'}</span></div>
        <Forecast forecast={stats.forecast} />
      </div>
      <div className="panel">
        <div className="panel-head"><h3>Activity</h3><span className="faint">{stats.totalReviews.toLocaleString()} reviews</span></div>
        <Heatmap heat={stats.heat} />
      </div>
    </div>
  );
}

export default function Home() {
  const params = useParams();
  const folderId = params.folderId ? Number(params.folderId) : null;
  const [decks, setDecks] = useState<Deck[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [modal, setModal] = useState<'deck' | 'folder' | 'rename' | 'custom' | null>(null);
  const [q, setQ] = useState('');
  const { toast, show: setToast } = useToast(1800);
  const nav = useNavigate();

  const load = useCallback(() => {
    api.decks().then(setDecks);
    api.folders().then(setFolders);
  }, []);
  useEffect(() => { load(); api.stats().then(setStats); }, [load, folderId]);

  const onDrop = useCallback(async (item: DragItem, target: number | null) => {
    try {
      if (item.kind === 'deck') await api.updateDeck(item.id, { folder_id: target });
      else if (item.id !== target) await api.updateFolder(item.id, { parent_id: target });
      else return;
      load();
    } catch (e) { setToast((e as Error).message); }
  }, [load, setToast]);

  const current = folderId != null ? folders.find((f) => f.id === folderId) : undefined;
  const path = folderPath(folders, folderId);
  const all = decks || [];

  // what "Study" means on this screen: everything, or everything in this folder
  const scopeDecks = folderId == null ? all : all.filter((d) => d.folder_id != null && subtree(folders, folderId).has(d.folder_id));
  const due = scopeDecks.reduce((a, d) => a + dueOf(d.counts), 0);
  const studyUrl = folderId == null ? '/study/all' : `/study/f${folderId}`;

  // rows: when searching, search the whole subtree flat; otherwise show direct children
  const s = q.trim().toLowerCase();
  const rowFolders = s ? folders.filter((f) => f.name.toLowerCase().includes(s) && (folderId == null || subtree(folders, folderId).has(f.id)) && f.id !== folderId) : folders.filter((f) => f.parent_id === folderId);
  const rowDecks = s ? scopeDecks.filter((d) => d.name.toLowerCase().includes(s)) : all.filter((d) => d.folder_id === folderId);
  const totalRows = folders.filter((f) => f.parent_id === folderId).length + all.filter((d) => d.folder_id === folderId).length;

  const cards = scopeDecks.reduce((a, d) => a + d.total, 0);

  return (
    <div>
      {folderId != null && (
        <nav className="crumbs">
          {[null, ...path].map((f, idx) => <Crumb key={f?.id ?? 'root'} folder={f} onDrop={onDrop} last={idx === path.length} />)}
        </nav>
      )}

      <section className="hero">
        <Mesh />
        {folderId != null && current && (
          <div className="corner">
            <button className="icon-btn" title="Rename folder" aria-label="Rename folder" onClick={() => setModal('rename')}><IconGear size={17} /></button>
          </div>
        )}
        <h1>{folderId == null ? 'Your library' : current?.name ?? ' '}</h1>
        <p>{scopeDecks.length} deck{scopeDecks.length === 1 ? '' : 's'} · {cards.toLocaleString()} cards</p>
        <div className="status">
          <span className={`dot ${due ? 'due' : 'ok'}`} />
          {decks === null ? ' ' : due ? `${due} card${due === 1 ? '' : 's'} due` : 'All caught up'}
        </div>
        <div className="actions">
          <button className="btn light lg" disabled={!due} onClick={() => nav(studyUrl)}>
            {due ? (folderId == null ? 'Study everything' : 'Study folder') : 'Nothing due'}
          </button>
          <button className="btn glass lg" onClick={() => setModal('custom')}>Custom study</button>
          <button className="btn glass lg" onClick={() => setModal('deck')}>New deck</button>
          {folderId != null && current && (
            <button className="btn glass lg" onClick={async () => {
              if (await ask({ title: `Delete folder “${current.name}”?`, body: 'Its decks and subfolders move up a level. No cards are deleted.', confirm: 'Delete folder', danger: true })) {
                await api.deleteFolder(current.id);
                nav(current.parent_id != null ? `/folder/${current.parent_id}` : '/');
              }
            }}>Delete folder</button>
          )}
        </div>
      </section>

      <div className="toolbar">
        <div className="search-field">
          <IconSearch size={16} />
          <input className="input" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="spacer" />
        <button className="btn" onClick={() => setModal('folder')}><IconFolder size={16} /> Folder</button>
      </div>

      <div className={folderId == null && stats ? 'columns' : ''}>
        <div>
          <div className="list">
            {decks === null && [0, 1, 2, 3].map((i) => (
              <div key={i} className="list-row skeleton" aria-hidden>
                <div className="tile" /><div className="body"><div className="bar w-40" /><div className="bar w-25" /></div>
              </div>
            ))}
            <AnimatePresence initial={false}>
              {rowFolders.map((f) => (
                <motion.div key={`f${f.id}`} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <FolderRow folder={f} folders={folders} decks={all} onDrop={onDrop} />
                </motion.div>
              ))}
              {rowDecks.map((d) => (
                <motion.div key={d.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <DeckRow d={d} />
                </motion.div>
              ))}
            </AnimatePresence>
            {decks !== null && rowFolders.length + rowDecks.length === 0 && (
              <div className="list-empty">
                {s ? 'Nothing matches.' : folderId == null ? (
                  <>
                    <p style={{ fontSize: 17, color: 'var(--text)', margin: '0 0 6px' }}>No decks yet</p>
                    <p className="m-0">Create one, or bring your decks over from Anki.</p>
                    <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
                      <button className="btn primary" onClick={() => setModal('deck')}>Create deck</button>
                      <button className="btn" onClick={() => nav('/import')}>Import from Anki</button>
                    </div>
                  </>
                ) : 'This folder is empty. Create a deck here, or drag decks onto it from the parent folder.'}
              </div>
            )}
          </div>
          {totalRows > 1 && !s && <div className="faint" style={{ fontSize: 13, marginTop: 10, paddingLeft: 4 }}>Drag a deck onto a folder or breadcrumb to move it.</div>}
        </div>
        {folderId == null && stats && <SidePanels stats={stats} />}
      </div>

      {modal === 'custom' && <CustomStudy scope={folderId == null ? 'all' : `f${folderId}`} title={folderId == null ? 'all decks' : current?.name ?? 'folder'} onClose={() => setModal(null)} />}
      {modal === 'deck' && (
        <NameModal title={current ? `New deck in “${current.name}”` : 'New deck'} withColor onClose={() => setModal(null)}
          onSubmit={async (name, color) => { const d = await api.createDeck({ name, color, folder_id: folderId }); setModal(null); nav(`/deck/${d.id}`); }} />
      )}
      {modal === 'folder' && (
        <NameModal title={current ? `New folder in “${current.name}”` : 'New folder'} onClose={() => setModal(null)}
          onSubmit={async (name) => { await api.createFolder(name, folderId); setModal(null); load(); }} />
      )}
      {modal === 'rename' && current && (
        <NameModal title="Rename folder" initial={current.name} onClose={() => setModal(null)}
          onSubmit={async (name) => { await api.updateFolder(current.id, { name }); setModal(null); load(); }} />
      )}
      {toast}
      <EnterToStudy enabled={due > 0} onGo={() => nav(studyUrl)} />
    </div>
  );
}

function EnterToStudy({ enabled, onGo }: { enabled: boolean; onGo: () => void }) {
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement) && !document.querySelector('.overlay')) onGo();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [enabled, onGo]);
  return null;
}
