import type { Deck, Folder, Counts } from './api';

/** Root-to-leaf chain of folders for a folder id. */
export function folderPath(folders: Folder[], id: number | null): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: Folder[] = [];
  let cur = id != null ? byId.get(id) : undefined;
  while (cur && out.length < 50) {
    out.unshift(cur);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
  }
  return out;
}

/** The folder id plus every folder nested inside it. */
export function subtree(folders: Folder[], id: number): Set<number> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parent_id != null && ids.has(f.parent_id) && !ids.has(f.id)) { ids.add(f.id); grew = true; }
  }
  return ids;
}

/** Totals for everything inside a folder (recursively). */
export function folderSummary(folders: Folder[], decks: Deck[], id: number) {
  const ids = subtree(folders, id);
  const inside = decks.filter((d) => d.folder_id != null && ids.has(d.folder_id));
  const counts: Counts = { new: 0, learn: 0, review: 0 };
  for (const d of inside) { counts.new += d.counts.new; counts.learn += d.counts.learn; counts.review += d.counts.review; }
  return {
    counts,
    decks: inside.length,
    cards: inside.reduce((a, d) => a + d.total, 0),
    colors: inside.slice(0, 4).map((d) => d.color),
  };
}

/** Flat list of folders as "A › B › C" labels, for pickers. */
export function folderOptions(folders: Folder[], exclude?: Set<number>) {
  return folders
    .filter((f) => !exclude?.has(f.id))
    .map((f) => ({ id: f.id, label: folderPath(folders, f.id).map((p) => p.name).join(' › ') }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
}
