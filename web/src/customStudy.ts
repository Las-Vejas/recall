// Custom study sessions as URL query strings (?mode=…&tags=…&days=…), shared by the dialog and the study screen.

export type StudyMode = 'due' | 'forgotten' | 'ahead';
export type CustomStudyQuery = { mode: StudyMode; tags: string[]; days: number };

export function customStudyQuery(q: CustomStudyQuery): string {
  const p = new URLSearchParams();
  if (q.mode !== 'due') p.set('mode', q.mode);
  if (q.mode === 'ahead') p.set('days', String(q.days));
  if (q.tags.length) p.set('tags', q.tags.join(','));
  return p.toString();
}

/** What a custom session is, in a few words, from its query string (for the study screen). */
export function describeCustomStudy(qs: URLSearchParams): string | null {
  const mode = qs.get('mode');
  const tags = (qs.get('tags') || '').split(',').filter(Boolean);
  const parts: string[] = [];
  if (mode === 'forgotten') parts.push('Forgotten today');
  if (mode === 'ahead') parts.push(`Reviewing ahead ${qs.get('days') || 1} day${qs.get('days') === '1' ? '' : 's'}`);
  if (tags.length) parts.push(`tagged ${tags.join(', ')}`);
  if (!parts.length) return null;
  const s = parts.join(', ');
  return s[0].toUpperCase() + s.slice(1);
}
