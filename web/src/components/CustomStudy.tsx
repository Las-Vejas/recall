// "Custom study": a one-off session over part of a scope (by tag), or a different queue
// (cards forgotten today, or reviews coming up in the next few days).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Counts } from '../api';
import { Modal } from './ui/Modal';
import { customStudyQuery, type CustomStudyQuery, type StudyMode } from '../customStudy';

const MODES: { v: StudyMode; label: string; help: string }[] = [
  { v: 'due', label: 'Due cards', help: 'The normal queue: reviews due now and today’s new cards.' },
  { v: 'forgotten', label: 'Forgotten today', help: 'Cards you pressed Again on today, until you get each one right.' },
  { v: 'ahead', label: 'Review ahead', help: 'Cards coming due soon, studied early. Handy before a trip or an exam.' },
];

export function CustomStudy({ scope, title, onClose }: { scope: string; title: string; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState<CustomStudyQuery>({ mode: 'due', tags: [], days: 3 });
  const [tags, setTags] = useState<{ tag: string; count: number }[] | null>(null);
  const [preview, setPreview] = useState<Counts | null>(null);
  const [err, setErr] = useState('');
  const qs = customStudyQuery(q);

  useEffect(() => { api.tags(scope).then(setTags).catch(() => setTags([])); }, [scope]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api.study(scope, qs).then((r) => { if (live) { setPreview(r.counts); setErr(''); } }).catch((e) => { if (live) setErr((e as Error).message); });
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [scope, qs]);

  const n = preview ? preview.new + preview.learn + preview.review : null;
  const toggleTag = (t: string) => setQ((x) => ({ ...x, tags: x.tags.includes(t) ? x.tags.filter((y) => y !== t) : [...x.tags, t] }));

  return (
    <Modal title={`Custom study · ${title}`} width={520} onClose={onClose}
      onSubmit={() => { if (n) { onClose(); nav(`/study/${scope}${qs ? `?${qs}` : ''}`); } }}>
      <div className="grid">
        <div className="choice-list" role="radiogroup" aria-label="What to study">
          {MODES.map((m) => (
            <label key={m.v} className={`choice ${q.mode === m.v ? 'on' : ''}`}>
              <input type="radio" name="mode" checked={q.mode === m.v} onChange={() => setQ({ ...q, mode: m.v })} />
              <span className="grow">
                <b>{m.label}</b>
                <span className="muted text-sm">{m.help}</span>
              </span>
              {m.v === 'ahead' && q.mode === 'ahead' && (
                <select className="input" value={q.days} aria-label="How many days ahead" onChange={(e) => setQ({ ...q, days: Number(e.target.value) })} onClick={(e) => e.stopPropagation()}>
                  {[1, 2, 3, 5, 7, 14, 30].map((d) => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>)}
                </select>
              )}
            </label>
          ))}
        </div>

        <div className="field">Only cards tagged
          {tags === null ? <span className="faint text-sm">Loading tags…</span>
            : tags.length === 0 ? <span className="faint text-sm">No tags in {title} yet. Add tags to cards to study them on their own.</span>
              : (
                <div className="tag-picks">
                  {tags.slice(0, 60).map((t) => (
                    <button type="button" key={t.tag} className={`tag-pick ${q.tags.includes(t.tag) ? 'on' : ''}`} aria-pressed={q.tags.includes(t.tag)} onClick={() => toggleTag(t.tag)}>
                      {t.tag} <span className="n">{t.count}</span>
                    </button>
                  ))}
                </div>
              )}
        </div>

        {err && <div className="form-error">{err}</div>}
        <div className="row">
          <span className="muted text-md">{n == null ? ' ' : n === 0 ? 'No cards match.' : `${n.toLocaleString()} card${n === 1 ? '' : 's'}`}</span>
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!n}>Start</button>
        </div>
      </div>
    </Modal>
  );
}
