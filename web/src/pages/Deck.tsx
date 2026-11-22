import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { api, fmtInterval, type Card, type Deck, type Folder } from '../api';
import { folderOptions, folderPath } from '../folders';
import CardContent from '../components/CardContent';
import { clozeNumbers, clozePlain, wrapSelection } from '../cloze';
import { IconGear, IconPlay, IconPlus, IconSearch } from '../components/Icons';
import { CountChips } from './Home';

const STATE = [
  { name: 'New', color: 'var(--new)' },
  { name: 'Learning', color: 'var(--learn)' },
  { name: 'Review', color: 'var(--review)' },
  { name: 'Relearn', color: 'var(--again)' },
];

function matches(c: Card, tab: 'all' | 'new' | 'learning' | 'review' | 'suspended') {
  if (tab === 'all') return true;
  if (tab === 'suspended') return !!c.suspended;
  if (c.suspended) return false;
  return tab === 'new' ? c.state === 0 : tab === 'review' ? c.state === 2 : c.state === 1 || c.state === 3;
}

const stripTags = (s: string) => s.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

type Kind = 'basic' | 'cloze';
const lastKind = (): Kind => { try { return localStorage.getItem('recall-card-kind') === 'cloze' ? 'cloze' : 'basic'; } catch { return 'basic'; } };

function CardEditor({ deckId, card, siblings, onClose, onSaved }: { deckId: number; card: Card | null; siblings: Card[]; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<Kind>(card ? (card.kind === 'cloze' ? 'cloze' : 'basic') : lastKind());
  const [front, setFront] = useState(card?.front ?? '');
  const [back, setBack] = useState(card?.back ?? '');
  const [tags, setTags] = useState(card?.tags ?? '');
  const [side, setSide] = useState<'front' | 'back'>('front');
  const [previewOrd, setPreviewOrd] = useState<number | null>(card?.cloze_ord ?? null);
  const [added, setAdded] = useState(0);
  const [err, setErr] = useState('');
  const frontRef = useRef<HTMLTextAreaElement>(null);
  const format = card?.format ?? 'md';
  const isCloze = kind === 'cloze';
  const nums = isCloze ? clozeNumbers(front) : [];
  const ord = previewOrd != null && nums.includes(previewOrd) ? previewOrd : nums[0] ?? null;

  const chooseKind = (k: Kind) => { setKind(k); setErr(''); try { localStorage.setItem('recall-card-kind', k); } catch { /* ignore */ } };

  const addCloze = (same: boolean) => {
    const el = frontRef.current;
    if (!el) return;
    const { next, caret } = wrapSelection(el, front, same);
    setFront(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caret, caret); });
  };

  const save = async (keepOpen = false) => {
    if (!front.trim()) return;
    setErr('');
    if (isCloze && !nums.length) return setErr('Add at least one cloze: select text and press Ctrl+Shift+C, or type {{c1::answer}}.');
    if (card?.kind === 'cloze') {
      const gone = siblings.filter((c) => c.cloze_ord != null && !nums.includes(c.cloze_ord));
      const withHistory = gone.filter((c) => c.state !== 0);
      if (withHistory.length && !confirm(`Removing ${gone.map((c) => `c${c.cloze_ord}`).join(', ')} deletes ${gone.length === 1 ? 'its card' : 'those cards'} and review history. Continue?`)) return;
    }
    try {
      if (card) await api.updateCard(card.id, { front, back, tags });
      else await api.addCard(deckId, { front, back, tags, kind });
    } catch (e) { return setErr((e as Error).message); }
    onSaved();
    if (keepOpen && !card) {
      setFront(''); setBack(''); setAdded((n) => n + (isCloze ? nums.length : 1));
      frontRef.current?.focus();
    } else onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <motion.div
        className="modal"
        style={{ maxWidth: 900 }}
        initial={{ opacity: 0, y: 20, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(!card); }
          // Ctrl+Shift+C like Anki (Cmd+Shift+C also works where the browser doesn't reserve it for devtools)
          if (isCloze && (e.code === 'KeyC' || e.key.toLowerCase() === 'c') && (e.metaKey || e.ctrlKey) && e.shiftKey) { e.preventDefault(); addCloze(e.altKey); }
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="row" style={{ marginBottom: 16, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>{card ? (card.kind === 'cloze' ? 'Edit cloze note' : 'Edit card') : 'Add cards'}</h2>
          {!card && format === 'md' && (
            <div className="kind-switch">
              <button className={!isCloze ? 'on' : ''} onClick={() => chooseKind('basic')}>Basic</button>
              <button className={isCloze ? 'on' : ''} onClick={() => chooseKind('cloze')}>Cloze</button>
            </div>
          )}
          {added > 0 && <span className="chip review">+{added} added</span>}
          <span className="spacer" />
          <span className="faint" style={{ fontSize: 12 }}>{format === 'md' ? 'Markdown supported' : 'HTML (imported)'} · <kbd>⌘</kbd> <kbd>↵</kbd> save</span>
        </div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
          <div className="grid">
            <label className="field">{isCloze ? 'Text' : 'Front'}
              <textarea ref={frontRef} autoFocus className="textarea" value={front} onChange={(e) => setFront(e.target.value)} onFocus={() => setSide('front')}
                placeholder={isCloze ? 'The {{c1::mitochondria}} is the {{c2::powerhouse::role}} of the cell' : undefined} />
            </label>
            {isCloze && (
              <div className="cloze-tools">
                <button type="button" className="btn sm" onClick={() => addCloze(false)}>[…] New cloze <kbd>Ctrl⇧C</kbd></button>
                <button type="button" className="btn sm ghost" onClick={() => addCloze(true)} disabled={!nums.length}>Same number <kbd>Ctrl⌥⇧C</kbd></button>
                <span className="spacer" />
                <span className="faint" style={{ fontSize: 13 }}>{nums.length ? `${nums.length} card${nums.length === 1 ? '' : 's'}` : 'no clozes yet'}</span>
              </div>
            )}
            <label className="field">{isCloze ? 'Extra (shown with the answer, optional)' : 'Back'}<textarea className="textarea" style={isCloze ? { minHeight: 60 } : undefined} value={back} onChange={(e) => setBack(e.target.value)} onFocus={() => setSide('back')} /></label>
            <label className="field">Tags<input className="input" value={tags} placeholder="space separated" onChange={(e) => setTags(e.target.value)} /></label>
          </div>
          <div>
            <div className="tabs" style={{ flexWrap: 'wrap' }}>
              <button className={side === 'front' ? 'on' : ''} onClick={() => setSide('front')}>Front</button>
              <button className={side === 'back' ? 'on' : ''} onClick={() => setSide('back')}>Back</button>
              {nums.length > 1 && <span style={{ width: 1, background: 'var(--line)', margin: '4px 6px' }} />}
              {nums.length > 1 && nums.map((n) => (
                <button key={n} className={ord === n ? 'on' : ''} onClick={() => setPreviewOrd(n)} title={`Preview card ${n}`}>c{n}</button>
              ))}
              <span className="spacer" />
              <span className="faint" style={{ fontSize: 12, alignSelf: 'center' }}>Live preview</span>
            </div>
            <div className="face" style={{ position: 'relative', minHeight: 260 }}>
              <div className="face-body">
                {front.trim()
                  ? <CardContent front={front} back={back} format={format} css={card?.css} side={side} kind={kind} cloze_ord={ord} />
                  : <span className="faint">{isCloze ? 'Select a word and press Ctrl+Shift+C to hide it' : 'Start typing…'}</span>}
              </div>
            </div>
          </div>
        </div>
        {err && <div style={{ color: 'var(--again)', fontSize: 14, marginTop: 14 }}>{err}</div>}
        <div className="row" style={{ marginTop: 20, flexWrap: 'wrap' }}>
          {card && (
            <>
              <button className="btn sm danger" onClick={async () => {
                const msg = card.kind === 'cloze' && siblings.length > 1 ? `Delete this note and all ${siblings.length} of its cards?` : 'Delete this card?';
                if (confirm(msg)) { await api.deleteCard(card.id); onSaved(); onClose(); }
              }}>{card.kind === 'cloze' && siblings.length > 1 ? `Delete note (${siblings.length} cards)` : 'Delete'}</button>
              <button className="btn sm" onClick={async () => { await api.updateCard(card.id, { suspended: card.suspended ? 0 : 1 }); onSaved(); onClose(); }}>{card.suspended ? 'Unsuspend' : 'Suspend'}{card.kind === 'cloze' ? ` c${card.cloze_ord}` : ''}</button>
              <button className="btn sm" onClick={async () => { if (confirm('Reset this card to new?')) { await api.forgetCard(card.id); onSaved(); onClose(); } }}>Reset progress</button>
            </>
          )}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>{card ? 'Cancel' : 'Done'}</button>
          <button className="btn primary" disabled={!front.trim()} onClick={() => save(!card)}>
            {card ? 'Save' : isCloze && nums.length > 1 ? `Add ${nums.length} cards` : 'Add card'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function BulkModal({ deckId, onClose, onSaved }: { deckId: number; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState('');
  const [sep, setSep] = useState('\t');
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  return (
    <div className="overlay" onClick={onClose}>
      <motion.div className="modal" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} onClick={(e) => e.stopPropagation()}>
        <h2>Bulk add</h2>
        <p className="muted" style={{ marginTop: -8 }}>One card per line: <code>front{sep === '\t' ? '⇥' : sep}back</code>. Paste straight from a spreadsheet.</p>
        <div className="grid">
          <select className="input" value={sep} onChange={(e) => setSep(e.target.value)}>
            <option value={'\t'}>Tab separated</option>
            <option value=";">Semicolon ;</option>
            <option value=",">Comma ,</option>
            <option value=" - ">Dash " - "</option>
            <option value="|">Pipe |</option>
          </select>
          <textarea className="textarea" style={{ minHeight: 240 }} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={'bonjour\thello\nmerci\tthank you'} />
          <div className="row">
            <span className="muted">{lines} card{lines === 1 ? '' : 's'}</span>
            <span className="spacer" />
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={!lines} onClick={async () => { await api.bulkAdd(deckId, text, sep); onSaved(); onClose(); }}>Add {lines}</button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function SettingsModal({ deck, folders, onClose, onSaved }: { deck: Deck; folders: Folder[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(deck.name);
  const [desc, setDesc] = useState(deck.description);
  const [npd, setNpd] = useState(deck.new_per_day);
  const [color, setColor] = useState(deck.color);
  const [folderId, setFolderId] = useState<number | null>(deck.folder_id);
  const nav = useNavigate();
  return (
    <div className="overlay" onClick={onClose}>
      <motion.div className="modal" style={{ maxWidth: 460 }} initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} onClick={(e) => e.stopPropagation()}>
        <h2>Deck settings</h2>
        <div className="grid">
          <label className="field">Name<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field">Description<input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
          <label className="field">New cards per day<input className="input" type="number" min={0} max={9999} value={npd} onChange={(e) => setNpd(Number(e.target.value))} /></label>
          <label className="field">Folder
            <select className="input" value={folderId ?? ''} onChange={(e) => setFolderId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">No folder (top level)</option>
              {folderOptions(folders).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
          <label className="field">Colour<input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 60, height: 34, border: 'none', background: 'none' }} /></label>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm danger" onClick={async () => { if (confirm(`Delete “${deck.name}” and all ${deck.total} cards? This cannot be undone.`)) { await api.deleteDeck(deck.id); nav(deck.folder_id != null ? `/folder/${deck.folder_id}` : '/'); } }}>Delete deck</button>
            <span className="spacer" />
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={async () => { await api.updateDeck(deck.id, { name, description: desc, new_per_day: npd, color, folder_id: folderId }); onSaved(); onClose(); }}>Save</button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

export default function DeckPage() {
  const id = Number(useParams().id);
  const nav = useNavigate();
  const [deck, setDeck] = useState<Deck | null>(null);
  const [cards, setCards] = useState<Card[]>([]);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Card | null | 'new'>(null);
  const [bulk, setBulk] = useState(false);
  const [settings, setSettings] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [tab, setTab] = useState<'all' | 'new' | 'learning' | 'review' | 'suspended'>('all');

  const load = useCallback(() => {
    api.deck(id).then(setDeck);
    api.folders().then(setFolders);
    api.cards(id, q).then(setCards);
  }, [id, q]);
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t); }, [load]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (document.querySelector('.overlay') || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'a') { e.preventDefault(); setEditing('new'); }
      if (e.key === 's' && deck) nav(`/study/${id}`);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [deck, id, nav]);

  if (!deck) return null;
  const due = deck.counts.new + deck.counts.learn + deck.counts.review;
  const tabCount = (f: typeof tab) => cards.filter((c) => matches(c, f)).length;
  const shown = cards.filter((c) => matches(c, tab));
  const mastery = deck.total ? Math.round((deck.mature / deck.total) * 100) : 0;

  return (
    <div>
      <nav className="crumbs">
        <span className="crumb"><Link to="/">Home</Link></span>
        {folderPath(folders, deck.folder_id).map((f) => (
          <span key={f.id} className="crumb"><Link to={`/folder/${f.id}`}>{f.name}</Link></span>
        ))}
        <span className="crumb"><span>{deck.name}</span></span>
      </nav>

      <motion.section className="head-panel" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
        <div className="tile" style={{ width: 52, height: 52, borderRadius: 14 }}><span className="swatch" style={{ background: deck.color, width: 20, height: 26 }} /></div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <h1>{deck.name}</h1>
            <span className={`pill ${due ? 'due' : 'ok'}`}><span className={`dot ${due ? 'due' : 'ok'}`} style={{ boxShadow: 'none' }} />{due ? `${due} due` : 'Up to date'}</span>
          </div>
          <div className="facts">
            <span>{deck.total} cards</span>
            <span>{mastery}% mature</span>
            <span>{deck.new_per_day} new / day</span>
            {deck.description && <span>{deck.description}</span>}
          </div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <CountChips c={deck.counts} />
          <button className="btn" onClick={() => setSettings(true)}><IconGear size={16} /> Settings</button>
          <button className="btn primary" disabled={!due} onClick={() => nav(`/study/${id}`)}><IconPlay size={15} /> {due ? `Study ${due}` : 'Nothing due'} <kbd>S</kbd></button>
        </div>
      </motion.section>

      <div className="toolbar">
        <div className="pilltabs">
          {(['all', 'new', 'learning', 'review', 'suspended'] as const).map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)} <span className="n">{tabCount(t)}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div className="search-field" style={{ width: 240 }}>
          <IconSearch size={16} />
          <input className="input" placeholder="Search cards" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn" onClick={() => setBulk(true)}>Bulk add</button>
        <button className="btn primary" onClick={() => setEditing('new')}><IconPlus size={16} /> Add card <kbd>A</kbd></button>
      </div>

      <div className="list">
        {shown.length === 0 && (
          <div className="list-empty">
            {q || tab !== 'all' ? 'No matching cards.' : <>This deck is empty. Press <kbd>A</kbd> to add your first card.</>}
          </div>
        )}
        <AnimatePresence initial={false}>
          {shown.map((c) => {
            const st = STATE[c.state];
            const dueIn = c.due - Date.now();
            return (
              <motion.div layout key={c.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div className="list-row" onClick={() => setEditing(c)} style={{ opacity: c.suspended ? 0.5 : 1 }}>
                  <div className="body" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 16 }}>
                    <div className="title" style={{ fontSize: 15 }}>
                      {c.kind === 'cloze' && <span className="mono faint" style={{ fontSize: 12, marginRight: 8 }}>c{c.cloze_ord}</span>}
                      {stripTags(c.kind === 'cloze' ? clozePlain(c.front, c.cloze_ord ?? null) : c.front) || <span className="faint">[media]</span>}
                    </div>
                    <div className="sub">{c.kind === 'cloze' ? stripTags(clozePlain(c.front, null)) : stripTags(c.format === 'html' ? c.back.replace(c.front, '') : c.back)}</div>
                  </div>
                  <div className="end">
                    {c.state !== 0 && <span className="meta mono" style={{ fontSize: 12 }} title="Due">{dueIn <= 0 ? 'due now' : `in ${fmtInterval(dueIn)}`}</span>}
                    <span className="state-pill" style={{ color: st.color, background: `color-mix(in srgb, ${st.color} 13%, transparent)` }}>{c.suspended ? 'Suspended' : st.name}</span>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {editing && <CardEditor deckId={id} card={editing === 'new' ? null : editing} siblings={editing !== 'new' && editing.note_id ? cards.filter((c) => c.note_id === editing.note_id) : []} onClose={() => setEditing(null)} onSaved={load} />}
      {bulk && <BulkModal deckId={id} onClose={() => setBulk(false)} onSaved={load} />}
      {settings && <SettingsModal deck={deck} folders={folders} onClose={() => setSettings(false)} onSaved={load} />}
    </div>
  );
}
