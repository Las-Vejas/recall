import { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { renderCloze } from '../cloze';
import { parseOcclusion } from '../occlusion';
import { compareTyped, expectedAnswer } from '../typein';
import type { CardKind } from '../api';
import { OcclusionView } from './Occlusion';

marked.setOptions({ breaks: true, gfm: true });

const PURIFY = {
  ADD_TAGS: ['audio', 'video', 'source', 'ruby', 'rt', 'details', 'summary'],
  ADD_ATTR: ['controls', 'preload', 'autoplay', 'target'],
};

export function renderMarkdown(src: string) {
  return DOMPurify.sanitize(marked.parse(src, { async: false }) as string, PURIFY);
}

// Base style for imported Anki cards: neutralise their light-mode colours so they sit nicely in our theme.
const ANKI_BASE = `
:host { display:block; width:100%; color: var(--text); font-family: var(--font); }
.card { font-size: clamp(18px, 2.4vw, 24px); line-height:1.45; text-align:center; }
.card, .card *:not(hr) { background-color: transparent !important; }
.card { color: inherit !important; }
img { max-width:100%; height:auto; border-radius:10px; }
hr#answer, hr { border:none; height:1px; background: var(--line); margin: 20px auto; width: 60%; }
.cloze { font-weight:700; color: var(--accent-2) !important; }
audio { max-width:100%; }
details.hint summary { cursor:pointer; color: var(--muted); font-size: .8em; }
a { color: var(--accent-2); }
`;

/** Renders imported Anki HTML inside a shadow root so its CSS can't leak into the app. */
function ShadowHtml({ html, css }: { html: string; css: string }) {
  const host = useRef<HTMLDivElement>(null);
  const clean = useMemo(() => DOMPurify.sanitize(html, PURIFY), [html]);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${css}\n${ANKI_BASE}</style><div class="card">${clean}</div>`;
  }, [clean, css]);
  return <div ref={host} />;
}

type Props = {
  front: string; back: string; format: 'md' | 'html'; css?: string; side: 'front' | 'back';
  kind?: CardKind; cloze_ord?: number | null;
  /** type-in cards: what the learner typed, compared with the back on the answer side */
  typed?: string;
};

/** What the learner typed, letter by letter against the expected answer. */
function TypedAnswer({ typed, expected }: { typed: string; expected: string }) {
  const v = compareTyped(typed, expected);
  return (
    <div className="typed">
      <span className={`typed-verdict ${v.correct ? 'ok' : v.almost ? 'almost' : 'no'}`}>
        {v.correct ? 'Correct' : v.almost ? 'Almost: check accents and punctuation' : typed.trim() ? 'Not quite' : 'No answer typed'}
      </span>
      {typed.trim() && !v.correct && (
        <div className="typed-diff">
          {v.parts.map((p, i) => <span key={i} className={p.kind}>{p.text}</span>)}
        </div>
      )}
    </div>
  );
}

export default function CardContent({ front, back, format, css = '', side, kind, cloze_ord = null, typed }: Props) {
  if (format === 'html') return <ShadowHtml html={side === 'front' ? front : back} css={css} />;
  if (kind === 'occlusion') {
    const data = parseOcclusion(front);
    if (!data) return <div className="faint">This image occlusion card is damaged.</div>;
    return (
      <div>
        <OcclusionView data={data} ord={cloze_ord} side={side} />
        {side === 'back' && back.trim() && (
          <>
            <div className="divider" />
            <div className="prose answer muted" dangerouslySetInnerHTML={{ __html: renderMarkdown(back) }} />
          </>
        )}
      </div>
    );
  }
  if (kind === 'cloze') {
    // front = cloze text, back = optional extra info shown under the answer
    return (
      <div>
        <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(renderCloze(front, cloze_ord, side === 'front' ? 'q' : 'a')) }} />
        {side === 'back' && back.trim() && (
          <>
            <div className="divider" />
            <div className="prose answer muted" dangerouslySetInnerHTML={{ __html: renderMarkdown(back) }} />
          </>
        )}
      </div>
    );
  }
  return (
    <div>
      <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(front) }} />
      {side === 'back' && (
        <>
          <div className="divider" />
          {kind === 'typein' && typed !== undefined && <TypedAnswer typed={typed} expected={expectedAnswer(back)} />}
          <div className="prose answer" dangerouslySetInnerHTML={{ __html: renderMarkdown(back) }} />
        </>
      )}
    </div>
  );
}
