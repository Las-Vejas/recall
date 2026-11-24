import { db } from './db.js';

// Natural order for names: numbers compare by value, so "2 Arrays" < "10 Files" and "1.2" < "1.10"; case-insensitive.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const byName = (a, b) => collator.compare(a.name, b.name);

/** Returns the id of the folder at the given path (e.g. ["Languages", "Spanish"]), creating any missing ones. */
export async function ensureFolderPath(parts, parentId = null, userId = null) {
  let current = parentId;
  for (const name of parts) {
    const existing = await db.get('SELECT id FROM folders WHERE name = ? AND parent_id IS ? AND user_id IS ?', name, current, userId);
    current = existing
      ? existing.id
      : await db.insert('INSERT INTO folders (name, parent_id, user_id, created_at) VALUES (?,?,?,?)', name, current, userId, Date.now());
  }
  return current;
}

/** Splits Anki's "A::B::C" deck name into folder path ["A","B"] and deck name "C". */
export function splitAnkiName(name) {
  const parts = name.split('::').map((p) => p.trim()).filter(Boolean);
  return { folders: parts.slice(0, -1), deck: parts[parts.length - 1] || name };
}

/** All folder ids in the subtree rooted at folderId (inclusive). */
export async function folderSubtree(folderId) {
  const rows = await db.all(`WITH RECURSIVE sub(id) AS (SELECT CAST(? AS ${db.dialect === 'pg' ? 'BIGINT' : 'INTEGER'}) UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id)
    SELECT id FROM sub`, folderId);
  return rows.map((r) => Number(r.id));
}

/** Every deck id inside a folder (including nested folders) that belongs to the user. */
export async function folderDeckIds(folderId, userId) {
  const ids = await folderSubtree(folderId);
  return (await db.all(`SELECT id FROM decks WHERE user_id = ? AND folder_id IN (${ids.map(() => '?').join(',')})`, userId, ...ids)).map((r) => r.id);
}

/** Deletes a folder but keeps its contents: decks and subfolders move up to its parent. */
export async function deleteFolder(id) {
  await db.tx(async () => {
    const f = await db.get('SELECT parent_id FROM folders WHERE id = ?', id);
    if (!f) return;
    await db.run('UPDATE decks SET folder_id = ? WHERE folder_id = ?', f.parent_id, id);
    await db.run('UPDATE folders SET parent_id = ? WHERE parent_id = ?', f.parent_id, id);
    await db.run('DELETE FROM folders WHERE id = ?', id);
  });
}

/** Moving a folder into itself or one of its descendants would create a cycle. */
export async function wouldCycle(folderId, newParentId) {
  return newParentId != null && (await folderSubtree(folderId)).includes(Number(newParentId));
}

/** One-time cleanup: decks still named "A::B" (from older imports) become deck "B" in folder "A". */
export async function migrateAnkiNames() {
  const decks = await db.all(`SELECT id, name, folder_id, user_id FROM decks WHERE name LIKE '%::%'`);
  if (!decks.length) return;
  await db.tx(async () => {
    for (const d of decks) {
      const { folders, deck } = splitAnkiName(d.name);
      const folderId = await ensureFolderPath(folders, d.folder_id, d.user_id);
      await db.run('UPDATE decks SET name = ?, folder_id = ? WHERE id = ?', deck, folderId, d.id);
    }
  });
  console.log(`Moved ${decks.length} "Parent::Child" deck(s) into folders`);
}
