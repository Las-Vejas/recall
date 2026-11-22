import { db } from './db.js';

/** Returns the id of the folder at the given path (e.g. ["Languages", "Spanish"]), creating any missing ones. */
export function ensureFolderPath(parts, parentId = null) {
  let current = parentId;
  for (const name of parts) {
    const existing = db.prepare('SELECT id FROM folders WHERE name = ? AND parent_id IS ?').get(name, current);
    current = existing
      ? existing.id
      : db.prepare('INSERT INTO folders (name, parent_id, created_at) VALUES (?,?,?)').run(name, current, Date.now()).lastInsertRowid;
  }
  return current;
}

/** Splits Anki's "A::B::C" deck name into folder path ["A","B"] and deck name "C". */
export function splitAnkiName(name) {
  const parts = name.split('::').map((p) => p.trim()).filter(Boolean);
  return { folders: parts.slice(0, -1), deck: parts[parts.length - 1] || name };
}

/** All folder ids in the subtree rooted at folderId (inclusive). */
export function folderSubtree(folderId) {
  return db.prepare(`WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN sub ON f.parent_id = sub.id)
    SELECT id FROM sub`).all(folderId).map((r) => r.id);
}

/** Every deck id inside a folder, including nested folders. */
export function folderDeckIds(folderId) {
  const ids = folderSubtree(folderId);
  return db.prepare(`SELECT id FROM decks WHERE folder_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.id);
}

/** Deletes a folder but keeps its contents: decks and subfolders move up to its parent. */
export function deleteFolder(id) {
  const f = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(id);
  if (!f) return;
  db.transaction(() => {
    db.prepare('UPDATE decks SET folder_id = ? WHERE folder_id = ?').run(f.parent_id, id);
    db.prepare('UPDATE folders SET parent_id = ? WHERE parent_id = ?').run(f.parent_id, id);
    db.prepare('DELETE FROM folders WHERE id = ?').run(id);
  })();
}

/** Moving a folder into itself or one of its descendants would create a cycle. */
export function wouldCycle(folderId, newParentId) {
  return newParentId != null && folderSubtree(folderId).includes(Number(newParentId));
}

/** One-time cleanup: decks still named "A::B" (from older imports) become deck "B" in folder "A". */
export function migrateAnkiNames() {
  const decks = db.prepare(`SELECT id, name, folder_id FROM decks WHERE name LIKE '%::%'`).all();
  if (!decks.length) return;
  db.transaction(() => {
    for (const d of decks) {
      const { folders, deck } = splitAnkiName(d.name);
      const folderId = ensureFolderPath(folders, d.folder_id);
      db.prepare('UPDATE decks SET name = ?, folder_id = ? WHERE id = ?').run(deck, folderId, d.id);
    }
  })();
  console.log(`Moved ${decks.length} "Parent::Child" deck(s) into folders`);
}
