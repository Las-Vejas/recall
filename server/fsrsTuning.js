// Fitting FSRS to one person's review history, and rescheduling their cards with the result.
import { Worker } from 'node:worker_threads';
import { db } from './db.js';
import { getPrefs, setInternal } from './prefs.js';
import { replayReviews, schedulerFor, serialize } from './scheduler.js';

/** Fewer training items than this and the fitted parameters are mostly noise (Anki uses a similar floor). */
export const MIN_ITEMS = 400;
const jobs = new Map(); // userId -> { running, progress, items, error, finishedAt }

/** The person's reviews in fsrs-rs's revlog CSV format (review_state uses Anki's revlog types). */
async function reviewCsv(userId) {
  const rows = await db.all('SELECT card_id, reviewed_at, rating, prev_state, duration_ms FROM reviews WHERE user_id = ? ORDER BY card_id, reviewed_at', userId);
  const type = (prev) => (prev === 2 ? 1 : prev === 3 ? 2 : 0); // learning 0, review 1, relearning 2
  const lines = ['card_id,review_time,review_rating,review_state,review_duration'];
  for (const r of rows) lines.push(`${r.card_id},${Number(r.reviewed_at)},${r.rating},${type(r.prev_state)},${Number(r.duration_ms) || 0}`);
  return { csv: lines.join('\n'), reviews: rows.length };
}

export function jobStatus(userId) {
  const j = jobs.get(userId);
  return j ? { running: j.running, progress: j.progress, items: j.items ?? null, error: j.error ?? null, finishedAt: j.finishedAt ?? null } : null;
}

/** Starts fitting parameters in a worker thread. Results land in the person's prefs; poll jobStatus(). */
export async function startOptimize(userId) {
  if (jobs.get(userId)?.running) return jobStatus(userId);
  const { csv, reviews } = await reviewCsv(userId);
  const prefs = await getPrefs(userId);
  const job = { running: true, progress: 0 };
  jobs.set(userId, job);
  const done = (patch) => { Object.assign(job, { running: false, finishedAt: Date.now(), ...patch }); };
  const worker = new Worker(new URL('./optimizeWorker.js', import.meta.url), {
    workerData: { csv, minItems: MIN_ITEMS, timezone: prefs.timezone || 0, dayStartsAt: 4 },
  });
  worker.on('message', async (m) => {
    if ('progress' in m) job.progress = m.progress;
    if ('items' in m) job.items = m.items;
    if (m.error) done({ error: m.error });
    if (m.params) {
      if (m.params.length !== 21 || m.params.some((x) => !Number.isFinite(x))) return done({ error: 'The optimizer returned unusable parameters' });
      await setInternal(userId, (p) => { p.params = m.params; p.optimized = { at: Date.now(), reviews, items: job.items }; });
      done({ progress: 1 });
    }
  });
  worker.on('error', (e) => done({ error: `Optimizer failed: ${e.message}` }));
  worker.on('exit', () => { if (job.running) done({ error: 'The optimizer stopped unexpectedly' }); });
  return jobStatus(userId);
}

/**
 * Recomputes every studied card's memory state and next due date from its review history with the
 * person's current parameters and retention. New cards (and cards reset to new) are left alone.
 */
export async function rescheduleAll(userId) {
  const prefs = await getPrefs(userId);
  const decks = await db.all('SELECT id, retention FROM decks WHERE user_id = ?', userId);
  let changed = 0;
  for (const d of decks) {
    const sched = schedulerFor(prefs, d.retention, false);
    const reviews = await db.all('SELECT card_id, rating, reviewed_at FROM reviews WHERE deck_id = ? ORDER BY card_id, reviewed_at', d.id);
    const byCard = new Map();
    for (const r of reviews) {
      let list = byCard.get(r.card_id);
      if (!list) byCard.set(r.card_id, (list = []));
      list.push({ rating: r.rating, at: Number(r.reviewed_at) });
    }
    const cards = await db.all('SELECT id, state FROM cards WHERE deck_id = ? AND state != 0', d.id);
    await db.tx(async () => {
      for (const c of cards) {
        const history = byCard.get(c.id);
        if (!history?.length) continue;
        const { card } = replayReviews(history, history[0].at, sched);
        if (card.state === 0) continue;
        await db.run('UPDATE cards SET fsrs = ?, state = ?, due = ? WHERE id = ?', serialize(card), card.state, card.due.getTime(), c.id);
        changed++;
      }
    });
  }
  return { rescheduled: changed };
}

export async function usableReviewCount(userId) {
  return (await db.get('SELECT COUNT(*) AS n FROM reviews WHERE user_id = ?', userId)).n;
}
