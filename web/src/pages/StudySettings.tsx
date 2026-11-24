// Account > Study: FSRS target retention, parameters fitted to your history, and leeches.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, timeAgo, type StudySettings, type StudySettingsPatch } from '../api';
import { SCard, Notice } from '../components/Settings';
import { ask } from '../components/ui/ask';

const pct = (r: number) => `${Math.round(r * 1000) / 10}%`;

export default function StudySettingsPage() {
  const [s, setS] = useState<StudySettings | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [fitted, setFitted] = useState(false); // the fit that just finished while this page was open
  const wasRunning = useRef(false);
  const apply = useCallback((next: StudySettings) => {
    if (wasRunning.current && !next.job?.running && !next.job?.error) setFitted(true);
    wasRunning.current = !!next.job?.running;
    setS(next);
  }, []);
  const load = useCallback(() => api.studySettings().then(apply).catch((e) => setMsg({ kind: 'error', text: (e as Error).message })), [apply]);
  useEffect(() => { load(); }, [load]);

  // while the optimizer runs, check on it every second
  const running = !!s?.job?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [running, load]);

  const save = async (patch: StudySettingsPatch) => {
    setMsg(null);
    try { setS(await api.updateStudySettings(patch)); } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  };

  const optimize = async () => {
    setMsg(null);
    setFitted(false);
    try { apply(await api.optimizeFsrs()); } catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  };

  const reschedule = async () => {
    if (!(await ask({ title: 'Reschedule your cards?', body: 'Every card you’ve studied gets a new due date from its review history, using your current parameters and retention. Cards may become due sooner or later.', confirm: 'Reschedule' }))) return;
    try { const r = await api.rescheduleCards(); setMsg({ kind: 'ok', text: `Rescheduled ${r.rescheduled.toLocaleString()} cards.` }); }
    catch (e) { setMsg({ kind: 'error', text: (e as Error).message }); }
  };

  if (!s) return msg ? <Notice kind="error">{msg.text}</Notice> : null;
  const retention = s.retention ?? s.defaultRetention;
  const [lo, hi] = s.retentionRange;

  return (
    <>
      {msg && <Notice kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Notice>}

      <SCard title="Target retention" desc="How likely you want to be to remember a card when it comes up. Higher means more reviews, spaced closer together. Decks can override this in their settings.">
        <div className="s-pad grid">
          <div className="row">
            <input type="range" className="range grow" min={lo} max={hi} step={0.01} value={retention} aria-label="Target retention"
              onChange={(e) => setS({ ...s, retention: Number(e.target.value) })}
              onPointerUp={(e) => save({ retention: Number((e.target as HTMLInputElement).value) })}
              onKeyUp={(e) => save({ retention: Number((e.target as HTMLInputElement).value) })} />
            <b className="text-lg num" style={{ minWidth: 64, textAlign: 'right' }}>{pct(retention)}</b>
          </div>
          <div className="row text-sm muted">
            <span>{s.retention == null ? `Using the server default (${pct(s.defaultRetention)}).` : retention >= 0.95 ? 'Very high: expect a lot of reviews.' : retention < 0.8 ? 'Low: fewer reviews, but you’ll forget more.' : 'A good range for most people is 85–92%.'}</span>
            <span className="spacer" />
            {s.retention != null && <button className="btn ghost sm" onClick={() => save({ retention: null })}>Use default</button>}
          </div>
        </div>
      </SCard>

      <SCard title="Personal parameters"
        desc="FSRS predicts when you’ll forget each card. Fitting its parameters to your own review history makes those predictions, and your intervals, match how you actually remember.">
        <div className="s-pad grid">
          <div className="text-md">
            {s.params
              ? <>Fitted to your history {timeAgo(s.optimized?.at ?? null)}, from {s.optimized?.reviews.toLocaleString()} reviews.</>
              : <>Using FSRS’s default parameters. You have {s.reviews.toLocaleString()} reviews; fitting needs a few hundred spread over weeks, and gets better with more.</>}
          </div>
          {running && (
            <div>
              <div className="meter"><div style={{ width: `${Math.round((s.job?.progress ?? 0) * 100)}%`, background: 'var(--accent)' }} /></div>
              <div className="faint text-sm mt-2">Fitting{s.job?.items ? ` to ${s.job.items.toLocaleString()} reviews` : ''}… you can leave this page.</div>
            </div>
          )}
          {s.job?.error && !running && <div className="form-error">{s.job.error}</div>}
          {fitted && <Notice kind="ok">New parameters are in use for your next reviews. Reschedule to apply them to cards already scheduled.</Notice>}
          <div className="row wrap">
            <button className="btn primary" onClick={optimize} disabled={running}>{running ? 'Fitting…' : s.params ? 'Fit again' : 'Fit to my history'}</button>
            <button className="btn" onClick={reschedule} disabled={running}>Reschedule cards</button>
            <span className="spacer" />
            {s.params && <button className="btn ghost sm" onClick={async () => {
              if (await ask({ title: 'Go back to the default parameters?', body: 'Your next reviews use FSRS’s defaults. You can fit again any time.', confirm: 'Use defaults' })) save({ params: null });
            }}>Use defaults</button>}
          </div>
        </div>
      </SCard>

      <SCard title="Leeches" desc="Cards you keep forgetting cost the most time. After this many lapses (and every half as many after), a card is tagged “leech”, and Recall can flag or suspend it so you can rewrite it. They’re listed on the Insights page.">
        <div className="s-pad row wrap">
          <label className="field">Lapses
            <input className="input" type="number" min={2} max={99} value={s.leech.threshold} style={{ width: 90 }}
              onChange={(e) => setS({ ...s, leech: { ...s.leech, threshold: Number(e.target.value) } })}
              onBlur={(e) => save({ leech: { threshold: Number(e.target.value) } })} />
          </label>
          <label className="field">Then
            <select className="input" value={s.leech.action} onChange={(e) => save({ leech: { action: e.target.value as StudySettings['leech']['action'] } })}>
              <option value="flag">Flag it</option>
              <option value="suspend">Suspend it</option>
              <option value="off">Do nothing</option>
            </select>
          </label>
        </div>
      </SCard>
    </>
  );
}
