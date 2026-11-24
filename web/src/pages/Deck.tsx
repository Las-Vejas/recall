import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { api, fmtInterval, type Card, type CardKind, type Deck, type Folder } from '../api';
import { folderOptions, folderPath } from '../folders';
import CardContent from '../components/CardContent';
import { clozeNumbers, clozePlain, wrapSelection } from '../cloze';
import { IconFlag, IconSearch } from '../components/Icons';
import { CountChips } from './Home';
import { OcclusionEditor } from '../components/Occlusion';
import { occlusionNumbers, parseOcclusion, type Occlusion } from '../occlusion';

const STATE = [
  { name: 'New', color: 'var(--new)' },
  { name: 'Learning', color: 'var(--learn)' },
  { name: 'Review', color: 'var(--review)' },
  { name: 'Relearn', color: 'var(--again)' },
];

type Tab = 'all' | 'new' | 'learning' | 'review' | 'suspended' | 'flagged';
function matches(c: Card, tab: Tab) {
  if (tab === 'all') return true;
  if (tab === 'flagged') return !!c.flagged;
  if (tab === 'suspended') return !!c.suspended;
  if (c.suspended) return false;
  return tab === 'new' ? c.state === 0 : tab === 'review' ? c.state === 2 : c.state === 1 || c.state === 3;
}

const stripTags = (s: string) => s.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
/** One-line plain text for the card list: drops Markdown syntax (bold, code, headings, links, images) as well as tags. */
const plain = (s: string) => stripTags(s
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt ? `[${alt}]` : '[image]'))
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2')
  .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|$|[.,!?;:])/g, '$1$2')
  .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, ''));

type Kind = CardKind;
const KINDS: { k: Kind; label: string }[] = [{ k: 'basic', label: 'Basic' }, { k: 'typein', label: 'Type in' }, { k: 'cloze', label: 'Cloze' }, { k: 'occlusion', label: 'Image' }];
const NOTE_KINDS: Kind[] = ['cloze', 'occlusion'];
const lastKind = (): Kind => {
  try { const k = localStorage.getItem('recall-card-kind') as Kind; return KINDS.some((x) => x.k === k) ? k : 'basic'; } catch { return 'basic'; }
};
/** How a note's card numbers are labelled: c1, c2 for cloze; #1, #2 for image boxes. */
const ordLabel = (kind: Kind | undefined, n: number | null | undefined) => (kind === 'occlusion' ? `#${n}` : `c${n}`);

function CardEditor({ deckId, card, siblings, onClose, onSaved }: { deckId: number; card: Card | null; siblings: Card[]; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<Kind>(card ? (card.kind ?? 'basic') : lastKind());
  const [front, setFront] = useState(card && card.kind !== 'occlusion' ? card.front : '');
  const [occ, setOcc] = useState<Occlusion | null>(card?.kind === 'occlusion' ? parseOcclusion(card.front) : null);
  const [back, setBack] = useState(card?.back ?? '');
  const [tags, setTags] = useState(card?.tags ?? '');
  const [side, setSide] = useState<'front' | 'back'>('front');
  const [previewOrd, setPreviewOrd] = useState<number | null>(card?.cloze_ord ?? null);
  const [added, setAdded] = useState(0);
  const [err, setErr] = useState('');
  const frontRef = useRef<HTMLTextAreaElement>(null);
  const format = card?.format ?? 'md';
  const isCloze = kind === 'cloze';
  const isOcc = kind === 'occlusion';
  const isNote = NOTE_KINDS.includes(kind);
  const nums = isCloze ? clozeNumbers(front) : isOcc ? occlusionNumbers(occ) : [];
  // what gets saved as the card's front (image occlusion keeps its image + boxes as JSON)
  const cardFront = isOcc ? (occ ? JSON.stringify(occ) : '') : front;
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
    setErr('');
    if (isOcc && !occ) return setErr('Choose an image first.');
    if (isOcc && !nums.length) return setErr('Drag over the image to hide at least one part.');
    if (!cardFront.trim()) return;
    if (isCloze && !nums.length) return setErr('Add at least one cloze: select text and press Ctrl+Shift+C, or type {{c1::answer}}.');
    if (kind === 'typein' && !back.trim()) return setErr('Put the answer to type on the back.');
    if (card && NOTE_KINDS.includes(card.kind ?? 'basic')) {
      const gone = siblings.filter((c) => c.cloze_ord != null && !nums.includes(c.cloze_ord));
      const withHistory = gone.filter((c) => c.state !== 0);
      if (withHistory.length && !confirm(`Removing ${gone.map((c) => ordLabel(card.kind, c.cloze_ord)).join(', ')} deletes ${gone.length === 1 ? 'its card' : 'those cards'} and review history. Continue?`)) return;
    }
    try {
      if (card) await api.updateCard(card.id, { front: cardFront, back, tags });
      else await api.addCard(deckId, { front: cardFront, back, tags, kind });
    } catch (e) { return setErr((e as Error).message); }
    onSaved();
    if (keepOpen && !card) {
      setFront(''); setBack(''); setOcc(null); setAdded((n) => n + (isNote ? nums.length : 1));
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
          <h2 style={{ margin: 0 }}>{card ? (card.kind === 'cloze' ? 'Edit cloze note' : card.kind === 'occlusion' ? 'Edit image occlusion' : 'Edit card') : 'Add cards'}</h2>
          {!card && format === 'md' && (
            <div className="kind-switch">
              {KINDS.map((x) => <button key={x.k} className={kind === x.k ? 'on' : ''} onClick={() => chooseKind(x.k)}>{x.label}</button>)}
            </div>
          )}
          {added > 0 && <span className="chip review">+{added} added</span>}
          <span className="spacer" />
          <span className="faint" style={{ fontSize: 12 }}>{format === 'md' ? 'Markdown supported' : 'HTML (imported)'} · <kbd>⌘</kbd> <kbd>↵</kbd> save</span>
        </div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
          <div className="grid">
            {isOcc ? (
              <OcclusionEditor value={occ} onChange={setOcc} />
            ) : (
              <label className="field">{isCloze ? 'Text' : kind === 'typein' ? 'Question' : 'Front'}
                <textarea ref={frontRef} autoFocus className="textarea" value={front} onChange={(e) => setFront(e.target.value)} onFocus={() => setSide('front')}
                  placeholder={isCloze ? 'The {{c1::mitochondria}} is the {{c2::powerhouse::role}} of the cell' : kind === 'typein' ? 'Capital of Peru?' : undefined} />
              </label>
            )}
            {isCloze && (
              <div className="cloze-tools">
                <button type="button" className="btn sm" onClick={() => addCloze(false)}>[…] New cloze <kbd>Ctrl⇧C</kbd></button>
                <button type="button" className="btn sm ghost" onClick={() => addCloze(true)} disabled={!nums.length}>Same number <kbd>Ctrl⌥⇧C</kbd></button>
                <span className="spacer" />
                <span className="faint" style={{ fontSize: 13 }}>{nums.length ? `${nums.length} card${nums.length === 1 ? '' : 's'}` : 'no clozes yet'}</span>
              </div>
            )}
            <label className="field">{isNote ? 'Extra (shown with the answer, optional)' : kind === 'typein' ? 'Answer to type (case doesn’t matter)' : 'Back'}
              <textarea className="textarea" style={isNote || kind === 'typein' ? { minHeight: 60 } : undefined} value={back} onChange={(e) => setBack(e.target.value)} onFocus={() => setSide('back')}
                placeholder={kind === 'typein' ? 'Lima' : undefined} /></label>
            <label className="field">Tags<input className="input" value={tags} placeholder="space separated" onChange={(e) => setTags(e.target.value)} /></label>
          </div>
          <div>
            <div className="tabs" style={{ flexWrap: 'wrap' }}>
              <button className={side === 'front' ? 'on' : ''} onClick={() => setSide('front')}>Front</button>
              <button className={side === 'back' ? 'on' : ''} onClick={() => setSide('back')}>Back</button>
              {nums.length > 1 && <span style={{ width: 1, background: 'var(--line)', margin: '4px 6px' }} />}
              {nums.length > 1 && nums.map((n) => (
                <button key={n} className={ord === n ? 'on' : ''} onClick={() => setPreviewOrd(n)} title={`Preview card ${n}`}>{ordLabel(kind, n)}</button>
              ))}
            </div>
            <div className="face" style={{ position: 'relative', minHeight: 260 }}>
              <div className="face-body">
                {cardFront.trim() && (!isOcc || nums.length)
                  ? <CardContent front={cardFront} back={back} format={format} css={card?.css} side={side} kind={kind} cloze_ord={ord} />
                  : <span className="faint">{isCloze ? 'Select a word and press Ctrl+Shift+C to hide it' : isOcc ? (occ ? 'Drag over the image to hide parts of it' : 'Add an image, then draw boxes over it') : 'Start typing…'}</span>}
              </div>
            </div>
          </div>
        </div>
        {err && <div style={{ color: 'var(--again)', fontSize: 14, marginTop: 14 }}>{err}</div>}
        <div className="row" style={{ marginTop: 20, flexWrap: 'wrap' }}>
          {card && (
            <>
              <button className="btn sm danger" onClick={async () => {
                const multi = NOTE_KINDS.includes(card.kind ?? 'basic') && siblings.length > 1;
                if (confirm(multi ? `Delete this note and all ${siblings.length} of its cards?` : 'Delete this card?')) { await api.deleteCard(card.id); onSaved(); onClose(); }
              }}>{NOTE_KINDS.includes(card.kind ?? 'basic') && siblings.length > 1 ? `Delete note (${siblings.length} cards)` : 'Delete'}</button>
              <button className="btn sm" onClick={async () => { await api.updateCard(card.id, { suspended: card.suspended ? 0 : 1 }); onSaved(); onClose(); }}>{card.suspended ? 'Unsuspend' : 'Suspend'}{NOTE_KINDS.includes(card.kind ?? 'basic') ? ` ${ordLabel(card.kind, card.cloze_ord)}` : ''}</button>
              <button className="btn sm" onClick={async () => { await api.updateCard(card.id, { flagged: card.flagged ? 0 : 1 }); onSaved(); onClose(); }}>{card.flagged ? 'Remove flag' : 'Flag'}</button>
              <button className="btn sm" onClick={async () => { if (confirm('Reset this card to new?')) { await api.forgetCard(card.id); onSaved(); onClose(); } }}>Reset progress</button>
            </>
          )}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>{card ? 'Cancel' : 'Done'}</button>
          <button className="btn primary" disabled={!cardFront.trim()} onClick={() => save(!card)}>
            {card ? 'Save' : isNote && nums.length > 1 ? `Add ${nums.length} cards` : 'Add card'}
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
  const [tab, setTab] = useState<Tab>('all');

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

      <section className="head-panel">
        <div className="tile" style={{ width: 52, height: 52, borderRadius: 14 }}><span className="swatch" style={{ background: deck.color, width: 20, height: 26 }} /></div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1>{deck.name}</h1>
          <div className="facts">
            <span>{deck.total} cards</span>
            <span>{mastery}% mature</span>
            <span>{deck.new_per_day} new / day</span>
            {deck.description && <span>{deck.description}</span>}
          </div>
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <CountChips c={deck.counts} />
          <button className="btn" onClick={() => setSettings(true)}>Settings</button>
          <button className="btn primary" disabled={!due} onClick={() => nav(`/study/${id}`)}>{due ? `Study ${due}` : 'Nothing due'} <kbd>S</kbd></button>
        </div>
      </section>

      <div className="toolbar">
        <div className="pilltabs">
          {(['all', 'new', 'learning', 'review', 'suspended', 'flagged'] as const).filter((t) => t !== 'flagged' || tabCount(t) > 0 || tab === 'flagged').map((t) => (
            <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)} <span className="n">{tabCount(t)}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div className="search-field">
          <IconSearch size={16} />
          <input className="input" placeholder="Search cards" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <button className="btn ghost" onClick={() => setBulk(true)}>Bulk add</button>
        <button className="btn" onClick={() => setEditing('new')}>Add card <kbd>A</kbd></button>
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
                      {NOTE_KINDS.includes(c.kind ?? 'basic') && <span className="mono faint" style={{ fontSize: 12, marginRight: 8 }}>{ordLabel(c.kind, c.cloze_ord)}</span>}
                      {c.kind === 'typein' && <span className="mono faint" style={{ fontSize: 12, marginRight: 8 }} title="Type the answer">type</span>}
                      {c.kind === 'occlusion'
                        ? 'Image occlusion'
                        : (c.format === 'html' ? stripTags : plain)(c.kind === 'cloze' ? clozePlain(c.front, c.cloze_ord ?? null) : c.front) || <span className="faint">[media]</span>}
                    </div>
                    <div className="sub">{c.kind === 'occlusion' ? (plain(c.back) || `${parseOcclusion(c.front)?.masks.length ?? 0} boxes`) : c.kind === 'cloze' ? plain(clozePlain(c.front, null)) : c.format === 'html' ? stripTags(c.back.replace(c.front, '')) : plain(c.back)}</div>
                  </div>
                  <div className="end">
                    {!!c.flagged && <span className="flag-mark" title="Flagged" aria-label="Flagged"><IconFlag size={15} /></span>}
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
