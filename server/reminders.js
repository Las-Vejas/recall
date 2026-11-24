// Study reminders as a Slack DM from the instance's bot (SLACK_BOT_TOKEN), once a day at the time each person
// picks, in their timezone, and only when cards are due.
//
// Slack app setup: create an app at api.slack.com/apps, add the bot token scopes chat:write and
// users:read.email (to find people by their Recall email), install it to the workspace, and set
// SLACK_BOT_TOKEN to its xoxb- token. Nothing else: no events, no interactivity.
import { db } from './db.js';
import { getPrefs, setInternal } from './prefs.js';
import { counts } from './scheduler.js';
import { userStats } from './stats.js';

const TOKEN = process.env.SLACK_BOT_TOKEN || '';
const API = (process.env.SLACK_API_URL || 'https://slack.com/api').replace(/\/+$/, '');
const TICK_MS = Number(process.env.REMINDER_TICK_MS) || 5 * 60_000;

export const slackConfigured = () => !!TOKEN;
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status, expected: true });

/** Calls a Slack Web API method (form-encoded, which every method accepts). Throws Slack's error code readably. */
async function slack(method, params) {
  if (!TOKEN) throw fail('Slack isn’t set up on this Recall (the admin needs to set SLACK_BOT_TOKEN)');
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) body.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  let res;
  try {
    res = await fetch(`${API}/${method}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' }, body });
  } catch (e) { throw fail(`Couldn’t reach Slack: ${e.message}`, 502); }
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const why = {
      users_not_found: 'No one in the Slack workspace has that email address',
      user_not_found: 'No Slack member with that ID in this workspace',
      missing_scope: `The Slack app is missing a permission (${data.needed || 'scope'}); the admin needs to add it and reinstall the app`,
      invalid_auth: 'Slack rejected the bot token (SLACK_BOT_TOKEN)',
      not_authed: 'Slack rejected the bot token (SLACK_BOT_TOKEN)',
      account_inactive: 'The Slack bot token belongs to a deactivated app or user',
      ratelimited: 'Slack is rate limiting us; try again in a minute',
    }[data.error] || `Slack said: ${data.error || res.status}`;
    throw fail(why, 502);
  }
  return data;
}

const memberOf = (u) => ({ id: u.id, name: u.profile?.display_name || u.real_name || u.name || u.id, team: u.team_id || null });

/** Links Slack by the account's email, or by a pasted member ID (Profile → ⋮ → Copy member ID). */
export async function linkSlack(user, { memberId } = {}) {
  let member;
  if (memberId) {
    if (!/^[UW][A-Z0-9]{5,20}$/.test(String(memberId).trim())) throw fail('A Slack member ID looks like U012AB3CD');
    member = memberOf((await slack('users.info', { user: String(memberId).trim() })).user);
  } else {
    if (!user.email) throw fail('Your Recall account has no email to look up');
    member = memberOf((await slack('users.lookupByEmail', { email: user.email })).user);
  }
  await setInternal(user.id, (p) => { p.reminder.slackUser = member; });
  return member;
}

export async function unlinkSlack(userId) {
  await setInternal(userId, (p) => { p.reminder.slackUser = null; p.reminder.enabled = false; });
}

const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

/** What a reminder would say right now: cards due, rough minutes, streak, and whether today's already done. */
export async function reminderSummary(userId) {
  const ids = (await db.all('SELECT id FROM decks WHERE user_id = ?', userId)).map((d) => d.id);
  const c = ids.length ? await counts(ids) : { new: 0, learn: 0, review: 0 };
  const due = c.new + c.learn + c.review;
  const avg = await db.get('SELECT AVG(duration_ms) AS ms FROM (SELECT duration_ms FROM reviews WHERE user_id = ? AND duration_ms > 0 ORDER BY id DESC LIMIT 300) t', userId);
  const perCard = Number(avg?.ms) || 8000;
  const stats = await userStats(userId);
  return { due, counts: c, minutes: Math.max(1, Math.round((due * perCard) / 60_000)), streak: stats.streak, studiedToday: stats.today.reviews };
}

function message(s) {
  const lines = [`*${s.due.toLocaleString('en')} card${s.due === 1 ? '' : 's'} due* · about ${s.minutes} min`];
  if (s.streak > 0) lines.push(s.studiedToday ? `🔥 ${s.streak}-day streak` : `🔥 ${s.streak}-day streak: study today to keep it going`);
  if (PUBLIC_URL) lines.push(`<${PUBLIC_URL}/study/all|Start studying →>`);
  return {
    text: `${s.due} Recall card${s.due === 1 ? '' : 's'} due`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: lines.join('\n') } }],
    unfurl_links: false,
  };
}

export async function sendReminder(userId, { force = false } = {}) {
  const p = await getPrefs(userId);
  const to = p.reminder.slackUser?.id;
  if (!to) throw fail('Connect Slack first');
  const s = await reminderSummary(userId);
  if (!s.due && !force) return { sent: false, summary: s };
  const m = force && !s.due ? { text: 'Recall test: nothing is due right now, so a real reminder would stay quiet.' } : message(s);
  await slack('chat.postMessage', { channel: to, ...m }); // posting to a member ID lands in the app's DM with them
  return { sent: true, summary: s };
}

/** Local date (YYYY-MM-DD) and time (HH:MM) in a timezone. */
export function localNow(tz, now = new Date()) {
  let parts;
  try { parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now); }
  catch { parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now); }
  const get = (t) => parts.find((x) => x.type === t)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

/** Is it time for today's reminder? Once per local day, at or after the chosen time. */
export function reminderDue(reminder, tz, now = new Date()) {
  if (!reminder?.enabled || !reminder.slackUser?.id) return false;
  const { date, time } = localNow(tz, now);
  return reminder.lastSent !== date && time >= reminder.time;
}

async function tick() {
  const users = await db.all(`SELECT id FROM users WHERE prefs LIKE '%"enabled":true%'`);
  for (const { id } of users) {
    try {
      const p = await getPrefs(id);
      if (!reminderDue(p.reminder, p.timezone)) continue;
      const { date } = localNow(p.timezone);
      // mark the day first: one check per day, whether or not anything was due (and no retry storm if Slack is down)
      await setInternal(id, (x) => { x.reminder.lastSent = date; });
      await sendReminder(id);
    } catch (e) {
      console.warn(`Reminder for user ${id} failed: ${e.message}`);
    }
  }
}

let timer = null;
export function startReminders() {
  if (!TOKEN || timer) return;
  timer = setInterval(() => { tick().catch((e) => console.warn(`Reminder check failed: ${e.message}`)); }, TICK_MS);
  timer.unref();
  console.log('Slack reminders on (SLACK_BOT_TOKEN is set).');
}
