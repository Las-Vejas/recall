// Card media (images/audio from Anki imports) lives in the database, so it's as permanent as the cards.
// Files written by older versions under DATA_DIR/media are still served as a fallback.
import fs from 'node:fs';
import path from 'node:path';
import { db, MEDIA_DIR } from './db.js';

const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', avif: 'image/avif', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/opus', mp4: 'video/mp4', webm: 'video/webm',
};
export const mimeFor = (name) => TYPES[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';

export async function putMedia(key, data, userId) {
  await db.run('INSERT INTO media (path, mime, data, user_id) VALUES (?,?,?,?) ON CONFLICT(path) DO UPDATE SET mime = excluded.mime, data = excluded.data',
    key, mimeFor(key), data, userId);
}

/** Express handler for /media/<prefix>/<name>. */
export async function serveMedia(req, res) {
  const key = decodeURIComponent(req.path.replace(/^\/+/, ''));
  if (!key || key.includes('..')) return res.status(400).end();
  // each person only sees media from their own imports
  const row = await db.get('SELECT mime, data FROM media WHERE path = ? AND user_id = ?', key, req.user.id);
  if (row) {
    res.set({ 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=2592000', 'X-Content-Type-Options': 'nosniff' });
    // SVGs can carry scripts; don't let them run if opened directly
    if (row.mime === 'image/svg+xml') res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    return res.send(Buffer.from(row.data));
  }
  // files from very old versions (pre-database media) belong to the instance owner
  const file = path.join(MEDIA_DIR, key);
  if (req.user.is_admin && file.startsWith(MEDIA_DIR + path.sep) && fs.existsSync(file)) return res.sendFile(file, { maxAge: '30d' });
  res.status(404).end();
}
