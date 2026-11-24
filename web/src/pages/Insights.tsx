import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ReviewLog } from '../api';

const DAY = 86_400_000;
const SESSION_GAP = 30 * 60_000;
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const RANGES = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'Year' },
  { days: 0, label: 'All time' },
];
const RATINGS = [
  { r: 1, label: 'Again', color: 'var(--again)' },
  { r: 2, label: 'Hard', color: 'var(--hard)' },
  { r: 3, label: 'Good', color: 'var(--good)' },
  { r: 4, label: 'Easy', color: 'var(--easy)' },
];
const SESSION_BUCKETS = [
  { max: 5, label: '<5m' },
  { max: 10, label: '5–10m' },
  { max: 20, label: '10–20m' },
  { max: 40, label: '20–40m' },
  { max: Infinity, label: '40m+' },
];
const POSITION_BUCKETS = [
  { max: 10, label: '1–10' },
  { max: 20, label: '11–20' },
  { max: 40, label: '21–40' },
  { max: 80, label: '41–80' },
  { max: Infinity, label: '81+' },
];

type Row = ReviewLog['rows'][number];
type Rate = { n: number; ok: number };

const dayKey = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
// Monday-first weekday, 0..6
const weekday = (t: number) => (new Date(t).getDay() + 6) % 7;
const weekKey = (t: number) => dayKey(t) - weekday(t) * DAY;
// new cards fail on first sight by design, so "recall" counts only cards you've seen before
const counted = (r: Row) => r[3] !== 0;
const pct = (x: Rate) => (x.n ? Math.round((x.ok / x.n) * 100) : null);
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' });
const fmtMin = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);
const fmtDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function analyse(log: ReviewLog, days: number) {
  const rows = log.rows;
  const today = dayKey(Date.now());
  const first = rows.length ? dayKey(rows[0][0]) : today;
  const start = days > 0 ? Math.max(today - (days - 1) * DAY, first) : first;
  const span = Math.round((today - start) / DAY) + 1;
  const weekly = span > 90;
  const bucketOf = weekly ? weekKey : dayKey;

  const grid = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  const hour = Array.from({ length: 24 }, () => ({ n: 0, rate: { n: 0, ok: 0 } }));
  const wd = Array.from({ length: 7 }, () => ({ n: 0, rate: { n: 0, ok: 0 } }));
  const ratings = [0, 0, 0, 0];
  const byDeck = new Map<number, { n: number; ms: number; rate: Rate }>();
  const series = new Map<number, { n: number; fresh: number; ms: number; ratings: number[] }>();
  const studied = new Set<number>();

  for (const r of rows) {
    const [t, ms, rating, prev, deck] = r;
    const h = new Date(t).getHours(), w = weekday(t), ok = rating > 1 ? 1 : 0;
    grid[w][h]++;
    hour[h].n++; wd[w].n++;
    if (counted(r)) { hour[h].rate.n++; hour[h].rate.ok += ok; wd[w].rate.n++; wd[w].rate.ok += ok; }
    ratings[rating - 1]++;
    const d = byDeck.get(deck) ?? { n: 0, ms: 0, rate: { n: 0, ok: 0 } };
    d.n++; d.ms += ms;
    if (counted(r)) { d.rate.n++; d.rate.ok += ok; }
    byDeck.set(deck, d);
    const b = bucketOf(t);
    const s = series.get(b) ?? { n: 0, fresh: 0, ms: 0, ratings: [0, 0, 0, 0] };
    s.n++; s.ms += ms; s.ratings[rating - 1]++;
    if (prev === 0) s.fresh++;
    series.set(b, s);
    studied.add(dayKey(t));
  }

  // how many of each weekday the range covers, so the weekday chart is an average, not a total
  const wdDays = Array(7).fill(0) as number[];
  for (let t = start; t <= today; t += DAY) wdDays[weekday(t)]++;

  // sessions: a gap of 30 minutes starts a new one
  const sessions: { start: number; ms: number; cards: number }[] = [];
  const position = POSITION_BUCKETS.map(() => ({ n: 0, ok: 0 }));
  let cur: { start: number; end: number; cards: number } | null = null;
  for (const r of rows) {
    const [t, ms, rating] = r;
    if (!cur || t - cur.end > SESSION_GAP) {
      if (cur) sessions.push({ start: cur.start, ms: cur.end - cur.start, cards: cur.cards });
      cur = { start: t - ms, end: t, cards: 0 };
    }
    cur.end = t; cur.cards++;
    if (counted(r)) {
      const p = position[POSITION_BUCKETS.findIndex((b) => cur!.cards <= b.max)];
      p.n++; p.ok += rating > 1 ? 1 : 0;
    }
  }
  if (cur) sessions.push({ start: cur.start, ms: cur.end - cur.start, cards: cur.cards });
  const sessionHist = SESSION_BUCKETS.map(() => 0);
  for (const s of sessions) sessionHist[SESSION_BUCKETS.findIndex((b) => s.ms / 60_000 < b.max)]++;

  let longest = 0, run = 0;
  for (let t = start; t <= today; t += DAY) { run = studied.has(t) ? run + 1 : 0; longest = Math.max(longest, run); }
  let current = 0;
  for (let t = studied.has(today) ? today : today - DAY; studied.has(t); t -= DAY) current++;

  const buckets: number[] = [];
  for (let t = bucketOf(start); t <= today; t += weekly ? 7 * DAY : DAY) buckets.push(t);
  const timeline = buckets.map((t) => ({ t, ...(series.get(t) ?? { n: 0, fresh: 0, ms: 0, ratings: [0, 0, 0, 0] }) }));

  const totalMs = rows.reduce((a, r) => a + r[1], 0);
  return {
    total: rows.length, totalMs, span, weekly, grid, hour, ratings, timeline, sessionHist, position,
    wd: wd.map((x, i) => ({ ...x, avg: wdDays[i] ? x.n / wdDays[i] : 0 })),
    sessions: {
      n: sessions.length,
      avgMs: sessions.length ? sessions.reduce((a, s) => a + s.ms, 0) / sessions.length : 0,
      avgCards: sessions.length ? rows.length / sessions.length : 0,
    },
    secPerCard: rows.length ? totalMs / rows.length / 1000 : 0,
    consistency: { studied: studied.size, span, longest, current },
    decks: [...byDeck.entries()]
      .map(([id, d]) => ({ id, ...d, deck: log.decks.find((x) => x.id === id) }))
      .sort((a, b) => b.n - a.n),
  };
}

type A = ReturnType<typeof analyse>;

function Bars({ data, height = 120, labelEvery = 1 }: { data: { v: number; tip: string; label?: string; muted?: boolean }[]; height?: number; labelEvery?: number }) {
  const max = Math.max(1, ...data.map((d) => d.v));
  return (
    <div>
      <div className="vbars" style={{ height }}>
        {data.map((d, i) => (
          <div key={i} className="col tip" data-tip={d.tip}>
            <div className="bar" style={{ height: `${(d.v / max) * 100}%`, ...(d.muted ? { background: 'var(--bg-2)' } : null) }} />
          </div>
        ))}
      </div>
      <div className="vbars-axis">
        {data.map((d, i) => <span key={i}>{i % labelEvery === 0 ? d.label : ''}</span>)}
      </div>
    </div>
  );
}

function Stacked({ data, keys, height = 120, labelEvery = 1 }: {
  data: { parts: number[]; tip: string; label?: string }[];
  keys: { label: string; color: string }[];
  height?: number; labelEvery?: number;
}) {
  const max = Math.max(1, ...data.map((d) => d.parts.reduce((a, b) => a + b, 0)));
  return (
    <div>
      <div className="vbars" style={{ height }}>
        {data.map((d, i) => (
          <div key={i} className="col tip" data-tip={d.tip}>
            <div className="stack" style={{ height: `${(d.parts.reduce((a, b) => a + b, 0) / max) * 100}%` }}>
              {d.parts.map((p, j) => p > 0 && <div key={j} style={{ flexGrow: p, background: keys[j].color }} />).reverse()}
            </div>
          </div>
        ))}
      </div>
      <div className="vbars-axis">
        {data.map((d, i) => <span key={i}>{i % labelEvery === 0 ? d.label : ''}</span>)}
      </div>
      <Legend keys={keys} />
    </div>
  );
}

function Legend({ keys }: { keys: { label: string; color: string }[] }) {
  return (
    <div className="legend">
      {keys.map((k) => <span key={k.label}><i style={{ background: k.color }} />{k.label}</span>)}
    </div>
  );
}

function Panel({ title, note, children, wide }: { title: string; note?: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={`panel${wide ? ' wide' : ''}`}>
      <div className="panel-head"><h3>{title}</h3>{note && <span className="faint">{note}</span>}</div>
      {children}
    </section>
  );
}

function WeekHour({ a }: { a: A }) {
  const max = Math.max(1, ...a.grid.flat());
  return (
    <div className="weekhour" role="img" aria-label="Reviews by weekday and hour">
      <span />
      {Array.from({ length: 24 }, (_, h) => <span key={h} className="axis">{h % 6 === 0 ? hourLabel(h) : ''}</span>)}
      {a.grid.map((row, w) => [
        <span key={`l${w}`} className="axis">{WEEKDAYS[w]}</span>,
        ...row.map((n, h) => (
          <div
            key={`${w}-${h}`}
            className="cell tip"
            data-tip={`${WEEKDAYS[w]} ${hourLabel(h)}: ${n} review${n === 1 ? '' : 's'}`}
            style={n ? { background: `color-mix(in srgb, var(--accent) ${20 + Math.ceil((n / max) * 4) * 20}%, var(--surface-2))` } : undefined}
          />
        )),
      ])}
    </div>
  );
}

function RateBars({ data }: { data: { label: string; rate: Rate }[] }) {
  return (
    <div className="hbars">
      {data.map((d) => {
        const p = pct(d.rate);
        return (
          <div key={d.label} className="hrow tip" data-tip={p == null ? `${d.label}: no reviews` : `${d.label}: ${p}% of ${d.rate.n}`}>
            <span className="name">{d.label}</span>
            <div className="meter"><div style={{ width: `${p ?? 0}%`, background: 'var(--good)' }} /></div>
            <span className="mono">{p == null ? '—' : `${p}%`}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Cards forgotten again and again: worth rewriting, splitting or deleting. */
function LeechesPanel() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.leeches>> | null>(null);
  const load = useCallback(() => { api.leeches().then(setData).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  if (!data || !data.cards.length) return null;
  const toggle = async (id: number, suspended: number) => { await api.updateCard(id, { suspended: suspended ? 0 : 1 }); load(); };
  return (
    <section className="panel mt-5">
      <div className="panel-head">
        <h3>Leeches</h3>
        <span className="faint">{data.cards.length} card{data.cards.length === 1 ? '' : 's'} forgotten {data.threshold}+ times · <Link className="text-accent" to="/account/study">settings</Link></span>
      </div>
      <p className="muted text-md m-0 mb-4">These cards cost you the most reviews. Usually the fix is to rewrite them: make the question more specific, split one fact into two, or add a memory hook.</p>
      <div className="leech-list">
        {data.cards.map((c) => (
          <div key={c.id} className="leech-row">
            <span className="deck-dot" style={{ background: c.deck_color }} />
            <div className="grow min-w-0">
              <div className="leech-front">{c.front || <span className="faint">(empty)</span>}</div>
              <div className="faint text-sm">{c.deck_name}</div>
            </div>
            <span className="pill sm due num">{c.lapses}×</span>
            {c.suspended ? <span className="pill sm">Suspended</span> : c.flagged ? <span className="pill sm">Flagged</span> : null}
            <button className="btn ghost sm" onClick={() => toggle(c.id, c.suspended)}>{c.suspended ? 'Unsuspend' : 'Suspend'}</button>
            <Link className="btn sm" to={`/deck/${c.deck_id}?card=${c.id}`}>Edit</Link>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function InsightsPage() {
  const [days, setDays] = useState(() => { try { return Number(localStorage.getItem('insights-range') ?? 90); } catch { return 90; } });
  const [log, setLog] = useState<ReviewLog | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setLog(null); setErr('');
    try { localStorage.setItem('insights-range', String(days)); } catch { /* private mode */ }
    api.reviewLog(days).then(setLog).catch((e) => setErr(e.message));
  }, [days]);
  const a = useMemo(() => (log ? analyse(log, days) : null), [log, days]);

  const bestHour = a && a.total ? a.hour.reduce((b, x, i) => (x.n > a.hour[b].n ? i : b), 0) : null;
  const bestDay = a && a.total ? a.wd.reduce((b, x, i) => (x.avg > a.wd[b].avg ? i : b), 0) : null;
  const unit = a?.weekly ? 'week' : 'day';
  const tlLabel = (t: number, i: number, n: number) => (i === 0 || i === n - 1 || i === Math.floor(n / 2) ? fmtDate(t) : '');
  const tlTip = (t: number) => (a?.weekly ? `Week of ${fmtDate(t)}` : fmtDate(t));

  return (
    <div className="page insights">
      <section className="insights-head">
        <h1 className="display">Insights</h1>
        <div className="tabs" role="tablist">
          {RANGES.map((r) => <button key={r.days} role="tab" aria-selected={days === r.days} className={days === r.days ? 'on' : ''} onClick={() => setDays(r.days)}>{r.label}</button>)}
        </div>
      </section>

      {err && <div className="notice error">{err}</div>}
      {!a && !err && <p className="faint">Loading…</p>}
      {a && a.total === 0 && <div className="panel faint">No reviews in this range yet. Study a few cards and your habits show up here.</div>}

      {a && a.total > 0 && (
        <>
          <div className="insight-stats">
            <div><div className="label">Reviews</div><div className="value">{a.total.toLocaleString()}<small>{fmtMin(a.totalMs)}</small></div></div>
            <div><div className="label">Days studied</div><div className="value">{a.consistency.studied}<small>of {a.consistency.span}</small></div></div>
            <div><div className="label">Longest streak</div><div className="value">{a.consistency.longest}<small>now {a.consistency.current}</small></div></div>
            <div><div className="label">Peak time</div><div className="value">{bestHour != null ? hourLabel(bestHour) : '—'}<small>{bestDay != null ? WEEKDAYS[bestDay] + 's' : ''}</small></div></div>
          </div>

          <div className="insights-grid">
            <Panel title="When you study" note="Weekday by hour" wide>
              <WeekHour a={a} />
            </Panel>

            <Panel title="Time of day" note={`${a.total.toLocaleString()} reviews`}>
              <Bars labelEvery={6} data={a.hour.map((h, i) => ({ v: h.n, label: hourLabel(i), tip: `${hourLabel(i)}: ${h.n} reviews${pct(h.rate) != null ? `, ${pct(h.rate)}% recalled` : ''}` }))} />
            </Panel>

            <Panel title="Day of week" note="Average reviews per day">
              <Bars data={a.wd.map((w, i) => ({ v: w.avg, label: WEEKDAYS[i], tip: `${WEEKDAYS[i]}: ${w.avg.toFixed(1)} a day, ${w.n} total` }))} />
            </Panel>

            <Panel title="Recall by time of day" note="Seen cards only">
              <RateBars data={[[0, 6, 'Night'], [6, 12, 'Morning'], [12, 18, 'Afternoon'], [18, 24, 'Evening']].map(([from, to, label]) => ({
                label: `${label} (${hourLabel(from as number)}–${hourLabel((to as number) % 24)})`,
                rate: a.hour.slice(from as number, to as number).reduce((s, h) => ({ n: s.n + h.rate.n, ok: s.ok + h.rate.ok }), { n: 0, ok: 0 }),
              }))} />
            </Panel>

            <Panel title="Recall by weekday" note="Seen cards only">
              <RateBars data={a.wd.map((w, i) => ({ label: WEEKDAYS[i], rate: w.rate }))} />
            </Panel>

            <Panel title="Sessions" note={`${a.sessions.n} sessions, a 30 minute break starts a new one`}>
              <div className="insight-stats inline">
                <div><div className="label">Average length</div><div className="value">{fmtMin(a.sessions.avgMs)}</div></div>
                <div><div className="label">Cards per session</div><div className="value">{Math.round(a.sessions.avgCards)}</div></div>
                <div><div className="label">Per card</div><div className="value">{a.secPerCard.toFixed(1)}<small>sec</small></div></div>
              </div>
              <Bars height={90} data={a.sessionHist.map((n, i) => ({ v: n, label: SESSION_BUCKETS[i].label, tip: `${SESSION_BUCKETS[i].label}: ${n} session${n === 1 ? '' : 's'}` }))} />
            </Panel>

            <Panel title="Tiredness" note="Recall by card number in a session">
              <RateBars data={a.position.map((p, i) => ({ label: `Cards ${POSITION_BUCKETS[i].label}`, rate: p }))} />
            </Panel>

            <Panel title="Seconds per card" note={`Per ${unit}`}>
              <Bars data={a.timeline.map((x, i, all) => ({
                v: x.n ? x.ms / x.n / 1000 : 0, label: tlLabel(x.t, i, all.length),
                tip: `${tlTip(x.t)}: ${x.n ? `${(x.ms / x.n / 1000).toFixed(1)}s a card` : 'no reviews'}`,
              }))} />
            </Panel>

            <Panel title="New and seen cards" note={`Per ${unit}`}>
              <Stacked
                keys={[{ label: 'New', color: 'var(--new)' }, { label: 'Seen before', color: 'var(--review)' }]}
                data={a.timeline.map((x, i, all) => ({ parts: [x.fresh, x.n - x.fresh], label: tlLabel(x.t, i, all.length), tip: `${tlTip(x.t)}: ${x.fresh} new, ${x.n - x.fresh} seen` }))}
              />
            </Panel>

            <Panel title="How you rate" note={RATINGS.map((r, i) => `${r.label} ${Math.round((a.ratings[i] / a.total) * 100)}%`).join(', ')}>
              <Stacked
                keys={RATINGS}
                data={a.timeline.map((x, i, all) => ({
                  parts: x.ratings, label: tlLabel(x.t, i, all.length),
                  tip: `${tlTip(x.t)}: ${RATINGS.map((r, j) => `${x.ratings[j]} ${r.label.toLowerCase()}`).join(', ')}`,
                }))}
              />
            </Panel>

            <Panel title="Decks" note={`${a.decks.length} studied`} wide>
              <table className="deck-table">
                <thead><tr><th>Deck</th><th>Reviews</th><th>Time</th><th>Recall</th></tr></thead>
                <tbody>
                  {a.decks.map((d) => {
                    const p = pct(d.rate);
                    return (
                      <tr key={d.id}>
                        <td><span className="dot" style={{ background: d.deck?.color ?? 'var(--muted)', borderRadius: 3, width: 10, height: 10 }} /> {d.deck?.name ?? 'Deleted deck'}</td>
                        <td>
                          <div className="row gap-2">
                            <div className="meter" style={{ flex: 1, marginTop: 0 }}><div style={{ width: `${(d.n / a.decks[0].n) * 100}%`, background: 'var(--accent)' }} /></div>
                            <span className="mono">{d.n}</span>
                          </div>
                        </td>
                        <td className="mono">{fmtMin(d.ms)}</td>
                        <td className="mono">{p == null ? '—' : `${p}%`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
          </div>
        </>
      )}
      <LeechesPanel />
    </div>
  );
}
