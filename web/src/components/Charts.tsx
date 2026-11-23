import { useEffect, useRef } from 'react';
import type { Stats } from '../api';

const DAY = 86_400_000;

export function Heatmap({ heat }: { heat: Stats['heat'] }) {
  const ref = useRef<HTMLDivElement>(null);
  // newest weeks are on the right; start scrolled there so "today" is visible on narrow screens
  useEffect(() => { if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth; }, [heat]);
  const byDay = new Map(heat.map((h) => [Math.round(h.date / DAY), h.n]));
  const max = Math.max(1, ...heat.map((h) => h.n));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // start on a Sunday ~52 weeks ago
  const start = new Date(today.getTime() - 364 * DAY);
  start.setDate(start.getDate() - start.getDay());
  const cells = [];
  for (let t = start.getTime(); t <= today.getTime(); t += DAY) {
    const d = new Date(t);
    const key = Math.round((t - d.getTimezoneOffset() * 60_000) / DAY);
    const n = byDay.get(key) || 0;
    const level = n === 0 ? 0 : Math.ceil((n / max) * 4);
    cells.push(
      <div
        key={t}
        className="cell"
        title={`${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}: ${n} reviews`}
        style={level ? { background: `color-mix(in srgb, var(--accent) ${20 + level * 20}%, var(--surface-2))` } : undefined}
      />,
    );
  }
  return <div className="heatmap" ref={ref}>{cells}</div>;
}

export function Forecast({ forecast }: { forecast: Stats['forecast'] }) {
  const days = Array.from({ length: 30 }, (_, i) => {
    // overdue cards (negative day) roll into today
    const n = forecast.filter((f) => (i === 0 ? f.day <= 0 : f.day === i)).reduce((a, f) => a + f.n, 0);
    return n;
  });
  const max = Math.max(1, ...days);
  if (!days.some(Boolean)) return <div className="forecast-empty">Nothing scheduled yet. Cards show up here once you've studied them.</div>;
  return (
    <div>
      <div className="forecast">
        {days.map((n, i) => (
          <div
            key={i}
            className="bar"
            data-tip={`${i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : `In ${i} days`}: ${n}`}
            style={{ height: `${(n / max) * 100}%`, opacity: n ? 1 : 0.3 }}
          />
        ))}
      </div>
      <div className="row faint" style={{ fontSize: 12, marginTop: 6 }}>
        <span>Today</span>
        <span className="spacer" />
        <span>30 days</span>
      </div>
    </div>
  );
}
