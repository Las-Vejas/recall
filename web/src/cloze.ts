// Cloze syntax (same as Anki): {{c1::answer}} or {{c1::answer::hint}}.
const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

export function clozeNumbers(text: string): number[] {
  const nums = new Set<number>();
  for (const m of text.matchAll(/\{\{c(\d+)::/g)) if (Number(m[1]) > 0) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}

export const nextClozeNumber = (text: string) => Math.max(0, ...clozeNumbers(text)) + 1;

/**
 * Turns cloze markup into markup for one card. `ord` is the cloze being tested:
 * on the question side it's hidden ([…] or the hint), on the answer side it's highlighted.
 * Other clozes just show their answer. Output is still Markdown (spans are inline HTML).
 */
export function renderCloze(text: string, ord: number | null, side: 'q' | 'a'): string {
  return text.replace(CLOZE_RE, (_, num: string, answer: string, hint?: string) => {
    if (ord == null || Number(num) !== ord) return answer;
    return side === 'q'
      ? `<span class="cloze blank">${hint ? escapeHtml(hint) : '…'}</span>`
      : `<span class="cloze">${answer}</span>`;
  });
}

/** Plain-text version for lists: the tested cloze becomes […]. */
export function clozePlain(text: string, ord: number | null) {
  return text.replace(CLOZE_RE, (_, num: string, answer: string, hint?: string) =>
    ord != null && Number(num) === ord ? `[${hint || '…'}]` : answer);
}

/** Wraps the textarea selection in a cloze (new number, or the same as the last one). */
export function wrapSelection(el: HTMLTextAreaElement, value: string, sameNumber: boolean) {
  const { selectionStart: a, selectionEnd: b } = el;
  const n = sameNumber ? Math.max(1, nextClozeNumber(value) - 1) : nextClozeNumber(value);
  const inner = value.slice(a, b);
  const open = `{{c${n}::`;
  const next = value.slice(0, a) + open + inner + '}}' + value.slice(b);
  // put the cursor inside the cloze when nothing was selected, after it otherwise
  const caret = inner ? a + open.length + inner.length + 2 : a + open.length;
  return { next, caret };
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
