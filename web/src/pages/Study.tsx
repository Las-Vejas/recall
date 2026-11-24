import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { describeCustomStudy } from '../customStudy';
import { AnimatePresence, motion, useMotionValue, useTransform, type PanInfo } from 'motion/react';
import confetti from 'canvas-confetti';
import { api, fmtDuration, fmtInterval, type Counts, type StudyCard } from '../api';
import CardContent from '../components/CardContent';
import { CountChips } from './Home';
import { useToast } from '../components/ui/Toast';
import { markDeckOpened } from '../recents';
import { IconClose, IconFlag, IconRedo, IconUndo } from '../components/Icons';

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

function Flashcard({ card, revealed, onReveal, onRate, typed, onType }: {
  card: StudyCard; revealed: boolean; onReveal: () => void; onRate: (r: Rating) => void;
  typed: string; onType: (s: string) => void;
}) {
  const typeIn = card.kind === 'typein' && card.format !== 'html';
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
          <div className="face-body">
            <div>
              <CardContent {...card} side="front" />
              {typeIn && (
                // pointer events stop here so tapping the field doesn't flip the card
                <input className="input type-answer" value={typed} autoFocus autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                  placeholder="Type the answer" enterKeyHint="done" aria-label="Your answer"
                  onPointerDown={(e) => e.stopPropagation()} onChange={(e) => onType(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onReveal(); } }} />
              )}
            </div>
          </div>
          {!typeIn && <div className="tap-hint" style={{ paddingBottom: 18 }}>Tap to reveal</div>}
        </div>
        <div className="face back" style={hintMeta ? { borderColor: hintMeta.color, boxShadow: `0 0 0 1px ${hintMeta.color}, 0 30px 80px -30px rgba(0,0,0,.55)` } : undefined}>
          <FaceHead card={card} />
          <div className="face-body">{revealed && <CardContent {...card} side="back" typed={typeIn ? typed : undefined} />}</div>
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
      <button className="btn primary lg mt-8" onClick={onBack} autoFocus>Back to decks</button>
    </motion.div>
  );
}

export default function Study() {
  const deck = useParams().deck!;
  const [params] = useSearchParams();
  const qs = params.toString(); // custom study: ?mode=…&tags=…
  const sessionLabel = describeCustomStudy(params);
  useEffect(() => { if (/^\d+$/.test(deck)) markDeckOpened(Number(deck)); }, [deck]);
  const nav = useNavigate();
  const [card, setCard] = useState<StudyCard | null>(null);
  const [counts, setCounts] = useState<Counts>({ new: 0, learn: 0, review: 0 });
  const [revealed, setRevealed] = useState(false);
  const [typed, setTyped] = useState(''); // type-in cards: the learner's answer
  const [done, setDone] = useState(false);
  const [exitDir, setExitDir] = useState<Rating | undefined>();
  const [session, setSession] = useState({ reviewed: 0, again: 0, ms: 0, combo: 0, best: 0 });
  const { toast, show: setToast } = useToast();
  const [redoable, setRedoable] = useState(0); // undos in this session that can still be redone
  const shownAt = useRef(Date.now());
  const busy = useRef(false);

  const show = useCallback((c: StudyCard | null, cnt: Counts) => {
    setCounts(cnt);
    setRevealed(false);
    setTyped('');
    if (!c) { setCard(null); setDone(true); return; }
    setDone(false);
    setCard(c);
    shownAt.current = Date.now();
  }, []);

  useEffect(() => { api.study(deck, qs).then((r) => show(r.card, r.counts)); }, [deck, qs, show]);

  const reveal = useCallback(() => {
    if (!card) return;
    (document.activeElement as HTMLElement | null)?.blur?.(); // leave the answer field, so keys rate the card again
    setRevealed(true);
  }, [card]);

  const rate = useCallback(async (r: Rating) => {
    if (!card || !revealed || busy.current) return;
    busy.current = true;
    const dur = Date.now() - shownAt.current;
    setExitDir(r);
    const id = card.id;
    setCard(null); // triggers exit animation immediately
    setRevealed(false); // swap the rating buttons back to "Show answer" right away, not after the network round trip
    setRedoable(0); // a new rating makes earlier undos final (server clears its redo stack too)
    setSession((s) => {
      const combo = r === 1 ? 0 : s.combo + 1;
      return { reviewed: s.reviewed + 1, again: s.again + (r === 1 ? 1 : 0), ms: s.ms + dur, combo, best: Math.max(s.best, combo) };
    });
    try {
      const res = await api.answer(deck, id, r, dur, qs);
      show(res.card, res.counts);
      const leech = res.result?.leech;
      if (leech) setToast(`Leech: forgotten ${leech.lapses} times, so it’s ${leech.action === 'suspend' ? 'suspended' : 'flagged'} (Z to undo)`);
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [card, revealed, deck, qs, show, setToast]);

  const undo = useCallback(async () => {
    if (busy.current) return;
    try {
      busy.current = true;
      setExitDir(undefined);
      const res = await api.undo(deck, qs);
      setSession((s) => ({ ...s, reviewed: Math.max(0, s.reviewed - 1), combo: Math.max(0, s.combo - 1) }));
      setRedoable((n) => n + 1);
      show(res.card, res.counts);
      setToast('Undone');
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      busy.current = false;
    }
  }, [deck, qs, show, setToast]);

  const redo = useCallback(async () => {
    if (busy.current) return;
    try {
      busy.current = true;
      setExitDir(3); // fly off like a normal rating
      const res = await api.redo(deck, qs);
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
  }, [deck, qs, show, setToast]);

  // flagging marks the card to come back to later; it doesn't touch scheduling
  const toggleFlag = useCallback(async () => {
    if (!card) return;
    const flagged = card.flagged ? 0 : 1;
    setCard({ ...card, flagged });
    try { await api.updateCard(card.id, { flagged }); setToast(flagged ? 'Flagged' : 'Flag removed'); }
    catch (e) { setCard(card); setToast((e as Error).message); }
  }, [card, setToast]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      // typing an answer: keys belong to the field (Enter is handled there); Escape leaves the field
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input, textarea, [contenteditable="true"]')) {
        if (e.key === 'Escape') el.blur();
        return;
      }
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
      if (e.key.toLowerCase() === 'f' && !e.repeat) { toggleFlag(); return; }
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!revealed) reveal();
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
  }, [revealed, reveal, rate, undo, redo, done, nav, toggleFlag]);

  const remaining = counts.new + counts.learn + counts.review;
  const progress = session.reviewed / Math.max(1, session.reviewed + remaining);

  return (
    <div className="study">
      <div className="study-top">
        <button className="icon-btn" onClick={() => nav(-1)} title="Leave (Esc)" aria-label="Leave"><IconClose size={17} /></button>
        <div className="progress"><div style={{ width: `${progress * 100}%` }} /></div>
        <CountChips c={counts} />
        <button className={`icon-btn${card?.flagged ? ' flag-on' : ''}`} onClick={toggleFlag} disabled={!card} title={card?.flagged ? 'Remove flag (F)' : 'Flag this card to come back to (F)'} aria-label={card?.flagged ? 'Remove flag' : 'Flag card'} aria-pressed={!!card?.flagged}><IconFlag size={17} /></button>
        <button className="icon-btn" onClick={undo} disabled={!session.reviewed} title="Undo (⌘Z / Ctrl+Z)" aria-label="Undo"><IconUndo size={17} /></button>
        <button className="icon-btn" onClick={redo} disabled={!redoable} title="Redo (⇧⌘Z / Ctrl+Shift+Z)" aria-label="Redo"><IconRedo size={17} /></button>
      </div>
      <div className="row" style={{ justifyContent: 'center', height: 22, marginTop: 8 }}>
        {sessionLabel && <span className="session-label">{sessionLabel}</span>}
        <AnimatePresence mode="popLayout">
          {session.combo >= 3 && (
            <motion.span key={session.combo} className="combo" initial={{ scale: 1.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ opacity: 0 }}>
              {session.combo} in a row
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <div className="stage" style={{ display: 'grid' }}>
        <AnimatePresence custom={exitDir}>
          {card && (
            <div key={card.id} style={{ gridArea: '1 / 1', width: '100%', display: 'grid', placeItems: 'center' }}>
              <Flashcard card={card} revealed={revealed} onReveal={reveal} onRate={rate} typed={typed} onType={setTyped} />
            </div>
          )}
        </AnimatePresence>
        {done && <div style={{ gridArea: '1 / 1' }}><Finished {...session} onBack={() => nav('/')} /></div>}
      </div>

      {!done && (
        <div style={{ minHeight: 84 }}>
          <AnimatePresence mode="wait">
            {revealed && card ? (
              <motion.div key="rate" className="ratings" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0 } }}>
                {RATINGS.map((x) => (
                  <button key={x.r} className="rate" style={{ '--c': x.color } as React.CSSProperties} onClick={() => rate(x.r)}>
                    <span className="name">{x.name}</span>
                    <span className="ivl">{fmtInterval(card.intervals[x.r])}</span>
                    <kbd>{x.key}</kbd>
                  </button>
                ))}
              </motion.div>
            ) : (
              // stays put between cards (no fade, no remount), so it doesn't flash while the next card loads
              <motion.button key="reveal" className="btn reveal-btn" onClick={reveal} initial={false} exit={{ opacity: 0, transition: { duration: 0.06 } }}>
                {card?.kind === 'typein' ? <>Check answer <kbd>enter</kbd></> : <>Show answer <kbd>space</kbd></>}
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      )}
      {toast}
    </div>
  );
}
