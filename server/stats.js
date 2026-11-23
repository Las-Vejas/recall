// Library statistics for one user: heatmap, forecast, streak, retention. Used by /api/stats and the MCP server.
import { db } from './db.js';
import { startOfToday } from './scheduler.js';

const DAY = 86_400_000;

export async function userStats(u) {
  const tzOffset = new Date().getTimezoneOffset() * 60_000;
  const since = startOfToday() - 364 * DAY;
  const heat = await db.all(`SELECT CAST((reviewed_at - ?) / ? AS INTEGER) AS day, COUNT(*) AS n, SUM(duration_ms) AS ms
    FROM reviews WHERE user_id = ? AND reviewed_at >= ? GROUP BY day`, tzOffset, DAY, u, since);
  const today = startOfToday();
  const forecast = await db.all(`SELECT CAST((c.due - ?) / ? AS INTEGER) AS day, COUNT(*) AS n FROM cards c JOIN decks d ON d.id = c.deck_id
    WHERE d.user_id = ? AND c.state != 0 AND c.suspended = 0 AND c.due < ? GROUP BY day`, today, DAY, u, today + 30 * DAY);
  const states = await db.all('SELECT c.state, COUNT(*) AS n FROM cards c JOIN decks d ON d.id = c.deck_id WHERE d.user_id = ? GROUP BY c.state', u);
  const todayRow = await db.get('SELECT COUNT(*) AS n, SUM(duration_ms) AS ms, SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS again FROM reviews WHERE user_id = ? AND reviewed_at >= ?', u, today);
  const ret = await db.get(`SELECT COUNT(*) AS n, SUM(CASE WHEN rating > 1 THEN 1 ELSE 0 END) AS ok FROM reviews
    WHERE user_id = ? AND prev_state = 2 AND reviewed_at >= ?`, u, today - 30 * DAY);
  const days = new Set(heat.map((h) => h.day));
  const todayIdx = Math.floor((Date.now() - tzOffset) / DAY);
  let streak = 0;
  for (let d = days.has(todayIdx) ? todayIdx : todayIdx - 1; days.has(d); d--) streak++;
  return {
    heat: heat.map((h) => ({ date: h.day * DAY, n: h.n, ms: h.ms })),
    forecast, states, streak,
    today: { reviews: todayRow.n || 0, ms: todayRow.ms || 0, again: todayRow.again || 0 },
    retention: ret.n ? ret.ok / ret.n : null,
    totalReviews: (await db.get('SELECT COUNT(*) AS n FROM reviews WHERE user_id = ?', u)).n,
  };
}
