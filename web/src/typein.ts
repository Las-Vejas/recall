// Type-in answers: compare what the learner typed with the expected answer (the card's back), Anki-style.

/** The back of a card as plain text: Markdown and HTML syntax removed, whitespace collapsed. */
export function expectedAnswer(back: string): string {
  return back
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, '$2')
    .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|$|[.,!?;:])/g, '$1$2')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export type DiffPart = { kind: 'same' | 'wrong' | 'missing'; text: string };
export type Verdict = { correct: boolean; almost: boolean; parts: DiffPart[] };

const tidy = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();
/** Ignores case, accents and punctuation: "close enough" rather than exact. */
const loose = (s: string) => tidy(s).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();

/**
 * Case-insensitive character diff of typed vs expected (longest common subsequence).
 * `same` and `wrong` parts are the learner's characters; `missing` parts are what they left out.
 */
export function compareTyped(typedRaw: string, expectedRaw: string): Verdict {
  const typed = [...tidy(typedRaw)].slice(0, 400);
  const expected = [...tidy(expectedRaw)].slice(0, 400);
  const a = typed.map((c) => c.toLowerCase()), b = expected.map((c) => c.toLowerCase());
  const n = a.length, m = b.length;
  // lcs[i][j] = LCS length of a[i:] and b[j:]
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const parts: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], ch: string) => {
    const last = parts[parts.length - 1];
    if (last?.kind === kind) last.text += ch; else parts.push({ kind, text: ch });
  };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { push('same', typed[i]); i++; j++; }
    // on a substitution, show the wrong letter first, then the one that was expected
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) { push('wrong', typed[i]); i++; }
    else { push('missing', expected[j]); j++; }
  }
  const correct = a.join('') === b.join('');
  return { correct, almost: !correct && !!typed.length && loose(typedRaw) === loose(expectedRaw), parts };
}
