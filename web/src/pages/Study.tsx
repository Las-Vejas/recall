import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AnimatePresence, motion, useMotionValue, useTransform, type PanInfo } from 'motion/react';
import confetti from 'canvas-confetti';
import { api, fmtDuration, fmtInterval, type Counts, type StudyCard } from '../api';
import CardContent from '../components/CardContent';
import { CountChips } from './Home';

type Rating = 1 | 2 | 3 | 4;
const RATINGS: { r: Rating; name: string; color: string; key: string; dir: string }[] = [
  { r: 1, name: 'Again', color: 'var(--again)', key: '1', dir: '←' },
  { r: 2, name: 'Hard', color: 'var(--hard)', key: '2', dir: '↓' },
  { r: 3, name: 'Good', color: 'var(--good)', key: '3', dir: '→' },
  { r: 4, name: 'Easy', color: 'var(--easy)', key: '4', dir: '↑' },
];
const EXIT: Record<Rating, { x: number; y: number; rotate: number }> = {
  1: { x: -700, y: 40, rotate: -18 },
  2: { x: 0, y: 700, rotate: 0 },
  3: { x: 700, y: 40, rotate: 18 },
  4: { x: 0, y: -700, rotate: 0 },
};
const SWIPE = 110;

function swipeRating(x: number, y: number): Rating | null {
  if (Math.abs(x) < SWIPE && Math.abs(y) < SWIPE) return null;
  if (Math.abs(x) >= Math.abs(y)) return x < 0 ? 1 : 3;
  return y < 0 ? 4 : 2;
}

function Flashcard({ card, revealed, onReveal, onRate }: {
  card: StudyCard; revealed: boolean; onReveal: () => void; onRate: (r: Rating) => void;
}) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useTransform(x, [-400, 400], [-14, 14]);
  const [hint, setHint] = useState<Rating | null>(null);
  const hintMeta = hint ? RATINGS[hint - 1] : null;

  return (
    <motion.div
      className="flashcard"
      style={{ x, y, rotate }}
      drag={revealed}
      dragSnapToOrigin
      dragElastic={0.9}
      onDrag={(_, i: PanInfo) => setHint(swipeRating(i.offset.x, i.offset.y))}
      onDragEnd={(_, i: PanInfo) => {
        const r = swipeRating(i.offset.x, i.offset.y);
        setHint(null);
        if (r) onRate(r);
      }}
      onTap={() => !revealed && onReveal()}
      initial={{ opacity: 0, y: 40, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: { type: 'spring', stiffness: 320, damping: 28 } }}
      variants={{
        out: (custom: Rating | undefined) => ({
          ...(custom ? EXIT[custom] : { y: -20 }), opacity: 0, transition: { duration: 0.32, ease: [0.4, 0, 0.2, 1] },
        }),
      }}
      exit="out"
    >
      <AnimatePresence>
        {hintMeta && (
          <motion.div
            className="drag-label"
            style={{ color: hintMeta.color, left: hint === 1 ? 'auto' : 22, right: hint === 1 ? 22 : 'auto', rotate: hint === 1 ? 10 : -10 }}
            initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
          >
            {hintMeta.name} · {fmtInterval(card.intervals[hintMeta.r])}
          </motion.div>
        )}
      </AnimatePresence>
      <motion.div
        style={{ position: 'absolute', inset: 0, transformStyle: 'preserve-3d' }}
        animate={{ rotateY: revealed ? 180 : 0 }}
        transition={{ type: 'spring', stiffness: 200, damping: 24 }}
      >
        <div className="face" style={hintMeta ? { borderColor: hintMeta.color } : undefined}>
          <FaceHead card={card} />
          <div className="face-body"><CardContent {...card} side="front" /></div>
          <div className="tap-hint" style={{ paddingBottom: 18 }}>Tap or press <kbd>space</kbd> to reveal</div>
        </div>
        <div className="face back" style={hintMeta ? { borderColor: hintMeta.color, boxShadow: `0 0 0 1px ${hintMeta.color}, 0 30px 80px -30px rgba(0,0,0,.55)` } : undefined}>
          <FaceHead card={card} />
          <div className="face-body">{revealed && <CardContent {...card} side="back" />}</div>
          <div className="tap-hint" style={{ paddingBottom: 18 }}>Swipe ← again · → good · ↑ easy · ↓ hard</div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function FaceHead({ card }: { card: StudyCard }) {
  const label = card.state === 0 ? 'New' : card.state === 2 ? `Review · ${card.reps} reps` : card.state === 3 ? 'Relearning' : 'Learning';
  return (
    <div className="face-head">
      <span className="dot" style={{ background: card.deck_color }} />
      <span>{card.deck_name}</span>
      <span className="spacer" />
      {card.tags && <span>{card.tags.split(' ').slice(0, 3).map((t) => `#${t}`).join(' ')}</span>}
      <span>{label}</span>
    </div>
  );
}

function Finished({ reviewed, again, ms, best, onBack }: { reviewed: number; again: number; ms: number; best: number; onBack: () => void }) {
  useEffect(() => {
    if (!reviewed) return;
    const end = Date.now() + 900;
    const colors = ['#8b6cff', '#3ddc97', '#4dabff', '#ffa94d', '#ff6b9a'];
    (function frame() {
      confetti({ particleCount: 4, angle: 60, spread: 60, origin: { x: 0, y: 0.7 }, colors });
      confetti({ particleCount: 4, angle: 120, spread: 60, origin: { x: 1, y: 0.7 }, colors });
      if (Date.now() < end) requestAnimationFrame(frame);
    })();
  }, [reviewed]);
  const acc = reviewed ? Math.round(((reviewed - again) / reviewed) * 100) : 0;
  return (
    <motion.div style={{ textAlign: 'center', maxWidth: 520 }} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <h1 className="display">{reviewed ? <>Session <em>complete.</em></> : <>Nothing due <em>right now.</em></>}</h1>
      {reviewed > 0 && (
        <div className="grid stats" style={{ marginTop: 32, gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="panel stat"><div className="label">Cards</div><div className="value">{reviewed}</div></div>
          <div className="panel stat"><div className="label">Correct</div><div className="value">{acc}<small>%</small></div></div>
          <div className="panel stat"><div className="label">Time</div><div className="value" style={{ fontSize: 28 }}>{fmtDuration(ms)}</div></div>
          <div className="panel stat"><div className="label">Best run</div><div className="value">{best}</div></div>
        </div>
      )}
      <button className="btn primary lg" style={{ marginTop: 32 }} onClick={onBack} autoFocus>Back to decks</button>
    </motion.div>
  );
}

export default function Study() {
  const deck = useParams().deck!;
  const nav = useNavigate();
  const [card, setCard] = useState<StudyCard | null>(null);
  const [counts, setCounts] = useState<Counts>({ new: 0, learn: 0, review: 0 });
  const [revealed, setRevealed] = useState(false);
  const [done, setDone] = useState(false);
  const [exitDir, setExitDir] = useState<Rating | undefined>();
  const [session, setSession] = useState({ reviewed: 0, again: 0, ms: 0, combo: 0, best: 0 });
  const [toast, setToast] = useState('');
  const [redoable, setRedoable] = useState(0); // undos in this session that can still be redone
  const shownAt = useRef(Date.now());
  const busy = useRef(false);

  const show = useCallback((c: StudyCard | null, cnt: Counts) => {
    setCounts(cnt);
    setRevealed(false);
    if (!c) { setCard(null); setDone(true); return; }
    setDone(false);
    setCard(c);
    shownAt.current = Date.now();
  }, []);

  useEffect(() => { api.study(deck).then((r) => show(r.card, r.counts)); }, [deck, show]);

  const rate = useCallback(async (r: Rating) => {
    if (!card || !revealed || busy.current) return;
    busy.current = true;
    const dur = Date.now() - shownAt.current;
    setExitDir(r);
    const id = card.id;
    setCard(null); // triggers exit animation immediately
    setRedoable(0); // a new rating makes earlier undos final (server clears its redo stack too)
    setSession((s) => {
      const combo = r === 1 ? 0 : s.combo + 1;
      return { reviewed: s.reviewed + 1, again: s.again + (r === 1 ? 1 : 0), ms: s.ms + dur, combo, best: Math.max(s.best, combo) };
    });
    try {
      const res = await api.answer(deck, id, r, dur);
      show(res.card, res.counts);
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [card, revealed, deck, show]);

  const undo = useCallback(async () => {
    if (busy.current) return;
    try {
      busy.current = true;
      setExitDir(undefined);
      const res = await api.undo(deck);
      setSession((s) => ({ ...s, reviewed: Math.max(0, s.reviewed - 1), combo: Math.max(0, s.combo - 1) }));
      setRedoable((n) => n + 1);
      show(res.card, res.counts);
      setToast('Undone');
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [deck, show]);

  const redo = useCallback(async () => {
    if (busy.current) return;
    try {
      busy.current = true;
      setExitDir(3); // fly off like a normal rating
      const res = await api.redo(deck);
      setSession((s) => ({ ...s, reviewed: s.reviewed + 1 }));
      setRedoable((n) => Math.max(0, n - 1));
      show(res.card, res.counts);
      setToast('Redone');
    } catch (e) {
      setRedoable(0);
      setToast((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [deck, show]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 1600);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      // undo: Z, Ctrl+Z or Cmd+Z (not Shift, which is "redo" by convention; not key-repeat, so holding it undoes once)
      const isZ = e.key.toLowerCase() === 'z' || e.code === 'KeyZ';
      const isY = e.key.toLowerCase() === 'y' || e.code === 'KeyY';
      const mod = e.metaKey || e.ctrlKey;
      // redo: Cmd/Ctrl+Shift+Z, or Ctrl+Y (Windows habit)
      if (!e.altKey && ((isZ && mod && e.shiftKey) || (isY && e.ctrlKey && !e.shiftKey))) {
        e.preventDefault();
        if (!e.repeat) redo();
        return;
      }
      // undo: Z, Ctrl+Z or Cmd+Z (not key-repeat, so holding it undoes once)
      if (isZ && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (!e.repeat) undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return; // leave other browser/OS shortcuts alone
      if (e.key === 'Escape') return nav(-1);
      if (done) { if (e.key === 'Enter') nav('/'); return; }
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!revealed) setRevealed(true);
        else rate(3);
        return;
      }
      if (revealed && ['1', '2', '3', '4'].includes(e.key)) rate(Number(e.key) as Rating);
      if (revealed && e.key === 'ArrowLeft') rate(1);
      if (revealed && e.key === 'ArrowRight') rate(3);
      if (revealed && e.key === 'ArrowUp') { e.preventDefault(); rate(4); }
      if (revealed && e.key === 'ArrowDown') { e.preventDefault(); rate(2); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [revealed, rate, undo, redo, done, nav]);

  const remaining = counts.new + counts.learn + counts.review;
  const progress = session.reviewed / Math.max(1, session.reviewed + remaining);

  return (
    <div className="study">
      <div className="study-top">
        <button className="btn ghost sm" onClick={() => nav(-1)} title="Esc">✕</button>
        <div className="progress"><div style={{ width: `${progress * 100}%` }} /></div>
        <CountChips c={counts} />
        <button className="btn ghost sm" onClick={undo} disabled={!session.reviewed} title="Undo (⌘Z / Ctrl+Z)">↺</button>
        <button className="btn ghost sm" onClick={redo} disabled={!redoable} title="Redo (⇧⌘Z / Ctrl+Shift+Z)">↻</button>
      </div>
      <div className="row" style={{ justifyContent: 'center', height: 22, marginTop: 8 }}>
        <AnimatePresence mode="popLayout">
          {session.combo >= 3 && (
            <motion.span key={session.combo} className="combo" initial={{ scale: 1.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0 }}>
              🔥 {session.combo} in a row
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <div className="stage" style={{ display: 'grid' }}>
        <AnimatePresence custom={exitDir}>
          {card && (
            <div key={card.id} style={{ gridArea: '1 / 1', width: '100%', display: 'grid', placeItems: 'center' }}>
              <Flashcard card={card} revealed={revealed} onReveal={() => setRevealed(true)} onRate={rate} />
            </div>
          )}
        </AnimatePresence>
        {done && <div style={{ gridArea: '1 / 1' }}><Finished {...session} onBack={() => nav('/')} /></div>}
      </div>

      {!done && (
        <div style={{ minHeight: 84 }}>
          <AnimatePresence mode="wait">
            {revealed && card ? (
              <motion.div key="rate" className="ratings" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.08 } }}>
                {RATINGS.map((x) => (
                  <button key={x.r} className="rate" style={{ '--c': x.color } as React.CSSProperties} onClick={() => rate(x.r)}>
                    <span className="name">{x.name}</span>
                    <span className="ivl">{fmtInterval(card.intervals[x.r])}</span>
                    <kbd>{x.key}</kbd>
                  </button>
                ))}
              </motion.div>
            ) : card ? (
              <motion.button key="reveal" className="btn reveal-btn" onClick={() => setRevealed(true)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.08 } }}>
                Show answer <kbd>space</kbd>
              </motion.button>
            ) : null}
          </AnimatePresence>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
