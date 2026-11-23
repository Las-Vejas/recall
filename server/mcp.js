// MCP (Model Context Protocol) server, so AI assistants (Claude, ChatGPT, Cursor, …) can use a Recall library as tools.
//
// Transport: Streamable HTTP at POST /mcp, stateless, answering with plain JSON (no SSE stream, no session id).
// Auth: "Authorization: Bearer rk_...", either an API token from Account → API tokens or one issued by signing in
// through OAuth (server/mcpAuth.js). Browser cookies are ignored, so a web page can't drive this endpoint on
// someone's behalf.
//
// The tools can read the library, add decks and cards, and study (rate cards, undo). Nothing edits or deletes
// existing cards, decks or settings.
import express from 'express';
import { db } from './db.js';
import * as auth from './auth.js';
import { nextCard, counts, answer, undoLast } from './scheduler.js';
import { parseDeckJson, importDecks } from './jsonImport.js';
import { folderDeckIds } from './folders.js';
import { userStats } from './stats.js';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'recall', title: 'Recall', version: '0.1.0' };
const INSTRUCTIONS = `Recall is the user's spaced-repetition flashcard library (FSRS scheduling).
- To create flashcards, use import_decks (new or existing deck by name) or add_cards (existing deck by id). Re-adding a card whose front already exists in the deck is skipped, so retrying is safe.
- To quiz the user: call next_card, show ONLY the question, wait for their answer, then reveal the answer and call answer_card with a rating (again = forgot, hard, good, easy). Let the user pick the rating when they can. undo_answer reverts the last rating.
- Cards are Markdown; cloze cards use {{c1::answer}} or {{c1::answer::hint}}, one card per number.
- Type-in cards ("typeIn": true) ask the learner to type the answer; when quizzing, have the user type it and compare with the back.`;

const STATE = ['new', 'learning', 'review', 'relearning'];
const RATINGS = { again: 1, hard: 2, good: 3, easy: 4 };
const MAX_TEXT = 4000;

// ---------- helpers ----------
class ToolError extends Error {}

const truncate = (s, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n)}… [truncated]` : s);

/** Anki cards are stored as rendered HTML; models read plain text more reliably. */
function htmlToText(html) {
  return String(html)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(div|p|li|tr|h\d)>/gi, '\n')
    .replace(/<hr[^>]*>/gi, '\n---\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
const clozeQuestion = (text, ord) => text.replace(CLOZE_RE, (_, n, a, hint) => (Number(n) === ord ? `[${hint || '…'}]` : a));
const clozeAnswer = (text, ord) => text.replace(CLOZE_RE, (_, n, a) => (Number(n) === ord ? `**${a}**` : a));

/** The two sides of a card as the user would see them while studying. */
function sides(c) {
  if (c.kind === 'occlusion') {
    let boxes = 0;
    try { boxes = JSON.parse(c.front).masks.filter((m) => m.n === c.cloze_ord).length; } catch { /* malformed: still describe it */ }
    const extra = c.back?.trim() ? `\n\n${c.back}` : '';
    return {
      question: `[Image occlusion card: ${boxes || 'some'} hidden part(s) of an image. Ask the user to open it in Recall; it can't be shown as text.]`,
      answer: `[The hidden part of the image is revealed in Recall.]${extra}`,
    };
  }
  if (c.kind === 'cloze') {
    return { question: clozeQuestion(c.front, c.cloze_ord), answer: clozeAnswer(c.front, c.cloze_ord) + (c.back?.trim() ? `\n\n${c.back}` : '') };
  }
  if (c.format === 'html') return { question: htmlToText(c.front), answer: htmlToText(c.back) };
  return { question: c.front, answer: c.back };
}

function humanInterval(ms) {
  const m = ms / 60_000;
  if (m < 1) return '<1 min';
  if (m < 60) return `${Math.round(m)} min`;
  if (m < 60 * 24) return `${Math.round(m / 60)} h`;
  const d = m / (60 * 24);
  if (d < 30) return `${Math.round(d)} d`;
  if (d < 365) return `${(d / 30).toFixed(1).replace(/\.0$/, '')} mo`;
  return `${(d / 365).toFixed(1).replace(/\.0$/, '')} y`;
}

async function folderPaths(userId) {
  const rows = await db.all('SELECT id, name, parent_id FROM folders WHERE user_id = ?', userId);
  const byId = new Map(rows.map((f) => [Number(f.id), f]));
  const pathOf = (id) => {
    const parts = [];
    for (let f = byId.get(Number(id)), guard = 0; f && guard < 100; f = byId.get(Number(f.parent_id)), guard++) parts.unshift(f.name);
    return parts;
  };
  return { rows, pathOf };
}

async function ownDeck(userId, id) {
  const d = await db.get('SELECT * FROM decks WHERE id = ? AND user_id = ?', id, userId);
  if (!d) throw new ToolError(`No deck with id ${id}. Call list_decks to see deck ids.`);
  return d;
}

/** deck_id / folder_id arguments → list of the user's deck ids (all decks when neither is given). */
async function scopeIds(userId, args) {
  if (args.deck_id != null) return [(await ownDeck(userId, args.deck_id)).id];
  if (args.folder_id != null) {
    const f = await db.get('SELECT id FROM folders WHERE id = ? AND user_id = ?', args.folder_id, userId);
    if (!f) throw new ToolError(`No folder with id ${args.folder_id}. Call list_decks to see folder ids.`);
    return folderDeckIds(f.id, userId);
  }
  return (await db.all('SELECT id FROM decks WHERE user_id = ?', userId)).map((r) => r.id);
}

const intArg = (v, name, { min = 0, max = Infinity, def } = {}) => {
  if (v == null) return def;
  if (!Number.isInteger(v) || v < min || v > max) throw new ToolError(`${name} must be a whole number between ${min} and ${max}`);
  return v;
};

// ---------- tools ----------
const SCOPE_PROPS = {
  deck_id: { type: 'integer', description: 'Only this deck (id from list_decks)' },
  folder_id: { type: 'integer', description: 'Every deck in this folder, including subfolders (id from list_decks)' },
};
const CARD_SCHEMA = {
  description: 'Basic {"front","back","tags"?} (add "typeIn": true to make the learner type the answer), short ["front","back"], or cloze {"cloze": "... {{c1::answer}} ...", "extra"?}. Markdown allowed.',
  anyOf: [
    { type: 'object', properties: { front: { type: 'string' }, back: { type: 'string' }, typeIn: { type: 'boolean', description: 'The learner types the answer, checked against the back' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['front'] },
    { type: 'object', properties: { cloze: { type: 'string' }, extra: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['cloze'] },
    { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
  ],
};
const READ = { readOnlyHint: true, openWorldHint: false };
const ADD = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const STUDY = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const TOOLS = [
  {
    name: 'list_decks',
    title: 'List decks',
    description: 'Lists every deck and folder in the library, with card totals and what is due to study now.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
    async run(userId) {
      const { rows, pathOf } = await folderPaths(userId);
      const decks = await db.all(`SELECT d.id, d.name, d.description, d.folder_id, d.new_per_day, COUNT(c.id) AS total
        FROM decks d LEFT JOIN cards c ON c.deck_id = d.id WHERE d.user_id = ? GROUP BY d.id ORDER BY d.name COLLATE NOCASE`, userId);
      return {
        decks: await Promise.all(decks.map(async (d) => ({
          id: Number(d.id), name: d.name, folder: d.folder_id ? pathOf(d.folder_id).join('/') : null,
          description: d.description || undefined, cards: Number(d.total), newPerDay: d.new_per_day, dueNow: await counts(d.id),
        }))),
        folders: rows.map((f) => ({ id: Number(f.id), path: pathOf(f.id).join('/') })).sort((a, b) => a.path.localeCompare(b.path)),
      };
    },
  },
  {
    name: 'search_cards',
    title: 'Search cards',
    description: 'Finds cards by text in the front, back or tags. Leave query empty to list cards. Optionally limit to one deck or folder.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for (case-insensitive)' },
        ...SCOPE_PROPS,
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        offset: { type: 'integer', minimum: 0, default: 0 },
      },
    },
    annotations: READ,
    async run(userId, args) {
      const ids = await scopeIds(userId, args);
      const limit = intArg(args.limit, 'limit', { min: 1, max: 200, def: 50 });
      const offset = intArg(args.offset, 'offset', { def: 0 });
      if (!ids.length) return { cards: [], total: 0 };
      const q = `%${String(args.query ?? '').trim()}%`;
      const where = `c.deck_id IN (${ids.map(() => '?').join(',')}) AND (c.front LIKE ? OR c.back LIKE ? OR c.tags LIKE ?)`;
      const total = (await db.get(`SELECT COUNT(*) AS n FROM cards c WHERE ${where}`, ...ids, q, q, q)).n;
      const rows = await db.all(`SELECT c.*, d.name AS deck_name FROM cards c JOIN decks d ON d.id = c.deck_id
        WHERE ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?`, ...ids, q, q, q, limit, offset);
      return {
        total: Number(total), offset, returned: rows.length,
        cards: rows.map((c) => {
          const s = sides(c);
          return {
            id: Number(c.id), deck_id: Number(c.deck_id), deck: c.deck_name, kind: c.kind,
            question: truncate(s.question, 1000), answer: truncate(s.answer, 1000),
            tags: c.tags ? c.tags.split(' ') : [], state: STATE[c.state], suspended: !!c.suspended,
            due: c.state === 0 ? null : new Date(Number(c.due)).toISOString(),
          };
        }),
      };
    },
  },
  {
    name: 'import_decks',
    title: 'Create decks / add cards by deck name',
    description: 'Creates decks with cards, or adds cards to the deck with the same name in the same folder. '
      + 'Cards whose front (or cloze text) is already in the deck are skipped. Up to 10,000 cards per call.',
    inputSchema: {
      type: 'object',
      properties: {
        decks: {
          type: 'array', minItems: 1,
          items: {
            type: 'object',
            properties: {
              deck: { type: 'string', description: 'Deck name' },
              folder: { type: 'string', description: 'Optional folder path like "Languages/Spanish", created if missing' },
              description: { type: 'string' },
              color: { type: 'string', description: 'Hex colour like "#e5484d" (new decks only)' },
              newPerDay: { type: 'integer', minimum: 0, maximum: 9999, description: 'New cards per day (new decks only, default 20)' },
              cards: { type: 'array', items: CARD_SCHEMA },
            },
            required: ['deck', 'cards'],
          },
        },
      },
      required: ['decks'],
    },
    annotations: ADD,
    async run(userId, args) {
      return importDecks(parse({ decks: args.decks }), userId);
    },
  },
  {
    name: 'add_cards',
    title: 'Add cards to a deck',
    description: 'Adds cards to an existing deck by id. Cards whose front (or cloze text) is already in the deck are skipped.',
    inputSchema: {
      type: 'object',
      properties: { deck_id: { type: 'integer', description: 'Deck id from list_decks' }, cards: { type: 'array', minItems: 1, items: CARD_SCHEMA } },
      required: ['deck_id', 'cards'],
    },
    annotations: ADD,
    async run(userId, args) {
      const deck = await ownDeck(userId, args.deck_id);
      const [parsed] = parse({ deck: deck.name, cards: args.cards });
      const { pathOf } = await folderPaths(userId);
      const result = await importDecks([{ ...parsed, deckId: deck.id, folder: deck.folder_id ? pathOf(deck.folder_id) : [] }], userId);
      return result.decks[0];
    },
  },
  {
    name: 'get_stats',
    title: 'Study stats',
    description: 'Today\'s reviews, cards due now, streak, 30-day retention, card counts by state and the 7-day review forecast.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ,
    async run(userId) {
      const s = await userStats(userId);
      const due = await counts(await scopeIds(userId, {}));
      const DAY = 86_400_000;
      return {
        dueNow: due,
        today: { reviews: s.today.reviews, minutes: Math.round(s.today.ms / 60_000), again: s.today.again },
        streakDays: s.streak,
        retention30d: s.retention == null ? null : Math.round(s.retention * 1000) / 10,
        totalReviews: Number(s.totalReviews),
        cards: Object.fromEntries(s.states.map((r) => [STATE[r.state], Number(r.n)])),
        forecastNext7Days: Array.from({ length: 7 }, (_, i) => ({
          day: i === 0 ? 'today (incl. overdue)' : new Date(Date.now() + i * DAY).toISOString().slice(0, 10),
          reviews: s.forecast.filter((f) => (i === 0 ? f.day <= 0 : f.day === i)).reduce((a, f) => a + Number(f.n), 0),
        })),
      };
    },
  },
  {
    name: 'next_card',
    title: 'Next card to study',
    description: 'Returns the next card due (learning, then reviews, then new cards within the daily limit). '
      + 'Show the user only the question first. Returns card: null when nothing is due.',
    inputSchema: { type: 'object', properties: { ...SCOPE_PROPS } },
    annotations: READ,
    async run(userId, args) {
      const ids = await scopeIds(userId, args);
      const c = ids.length ? await nextCard(ids, null) : null;
      const remaining = await counts(ids);
      if (!c) return { card: null, remaining, message: 'Nothing left to study right now.' };
      const s = sides(c);
      return {
        card: {
          id: Number(c.id), deck: c.deck_name, kind: c.kind, state: STATE[c.state],
          question: truncate(s.question), answer: truncate(s.answer),
          nextIntervalIf: Object.fromEntries(Object.entries(RATINGS).map(([k, r]) => [k, humanInterval(c.intervals[r])])),
        },
        remaining,
      };
    },
  },
  {
    name: 'answer_card',
    title: 'Rate a card',
    description: 'Records how well the user remembered a card and reschedules it: again (forgot), hard, good or easy.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'integer' },
        rating: { type: 'string', enum: Object.keys(RATINGS) },
        seconds: { type: 'number', minimum: 0, description: 'Optional: how long the user took to answer' },
      },
      required: ['card_id', 'rating'],
    },
    annotations: STUDY,
    async run(userId, args) {
      const rating = RATINGS[String(args.rating).toLowerCase()];
      if (!rating) throw new ToolError('rating must be one of: again, hard, good, easy');
      const card = await db.get('SELECT c.id FROM cards c JOIN decks d ON d.id = c.deck_id WHERE c.id = ? AND d.user_id = ?', args.card_id, userId);
      if (!card) throw new ToolError(`No card with id ${args.card_id}`);
      const r = await answer(userId, card.id, rating, (Number(args.seconds) || 0) * 1000);
      return { card_id: Number(card.id), rating: args.rating, state: STATE[r.state], nextReview: new Date(r.due).toISOString(), in: humanInterval(r.due - Date.now()) };
    },
  },
  {
    name: 'undo_answer',
    title: 'Undo last rating',
    description: 'Reverts the most recent rating (in the given deck or folder, or anywhere), putting the card back as it was.',
    inputSchema: { type: 'object', properties: { ...SCOPE_PROPS } },
    annotations: STUDY,
    async run(userId, args) {
      const ids = await scopeIds(userId, args);
      const cardId = ids.length ? await undoLast(ids) : null;
      if (!cardId) throw new ToolError('Nothing to undo');
      return { undone: true, card_id: Number(cardId) };
    },
  },
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function parse(input) {
  try { return parseDeckJson(input); } catch (e) { throw new ToolError(e.message); }
}

// ---------- JSON-RPC ----------
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handle(msg, userId) {
  const isRequest = msg && typeof msg === 'object' && msg.jsonrpc === '2.0' && typeof msg.method === 'string';
  if (!isRequest) return msg && (msg.result !== undefined || msg.error !== undefined) ? null : rpcError(msg?.id, -32600, 'Invalid request');
  const notification = msg.id === undefined;
  const ok = (result) => (notification ? null : { jsonrpc: '2.0', id: msg.id, result });
  const params = msg.params || {};

  switch (msg.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return ok({
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOL_BY_NAME.get(params.name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${params.name}`);
      try {
        const out = await tool.run(userId, params.arguments || {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out });
      } catch (e) {
        if (!(e instanceof ToolError)) console.error(`MCP tool ${tool.name} failed:`, e);
        return ok({ content: [{ type: 'text', text: e instanceof ToolError ? e.message : `Recall error: ${e.message}` }], isError: true });
      }
    }
    default:
      if (notification || msg.method.startsWith('notifications/')) return null;
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export function mcpRouter({ resourceMetadata } = {}) {
  const r = express.Router();
  // bearer-only, so any origin may call it (browser-based MCP clients do); cookies are never read here
  r.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Expose-Headers', 'WWW-Authenticate');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  r.post('/', async (req, res) => {
    const user = await auth.userFromBearer(req.headers.authorization).catch(() => null);
    if (!user) {
      const meta = resourceMetadata ? `, resource_metadata="${resourceMetadata(req)}"` : '';
      res.set('WWW-Authenticate', `Bearer realm="recall"${meta}${req.headers.authorization ? ', error="invalid_token"' : ''}`);
      return res.status(401).json(rpcError(null, -32001, 'Sign in to Recall to connect, or send "Authorization: Bearer rk_..." with an API token from Account > API tokens.'));
    }
    const body = req.body;
    const batch = Array.isArray(body);
    if (batch && !body.length) return res.status(400).json(rpcError(null, -32600, 'Empty batch'));
    const replies = (await Promise.all((batch ? body : [body]).map((m) => handle(m, user.id).catch((e) => {
      console.error('MCP request failed:', e);
      return rpcError(m?.id, -32603, 'Internal error');
    })))).filter(Boolean);
    if (!replies.length) return res.status(202).end(); // only notifications/responses
    res.json(batch ? replies : replies[0]);
  });

  // stateless server: no server-initiated SSE stream and no sessions to end
  r.all('/', (req, res) => res.set('Allow', 'POST').status(405).json(rpcError(null, -32000, 'Method not allowed: use POST')));

  return r;
}

/** Mount after mcpRouter(): malformed or oversized bodies (rejected by express.json earlier) become JSON-RPC errors. */
export function mcpErrors(err, req, res, next) {
  if (err?.type === 'entity.parse.failed') return res.status(400).json(rpcError(null, -32700, 'Parse error'));
  if (err?.type === 'entity.too.large') return res.status(413).json(rpcError(null, -32600, 'Request too large (5 MB max)'));
  next(err);
}
