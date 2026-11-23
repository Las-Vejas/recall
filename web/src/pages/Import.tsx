import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { api, type JsonImportResult } from '../api';
import { agentPrompt } from '../agentPrompt';
import { IconImport, IconKey } from '../components/Icons';

type AnkiResult = { imported: number; skipped: number; decks: number; media: number };
type Result = { kind: 'anki'; r: AnkiResult } | { kind: 'json'; r: JsonImportResult };

const EXAMPLE = `{
  "deck": "Spanish verbs",
  "folder": "Languages/Spanish",
  "cards": [
    { "front": "hablar", "back": "to speak" },
    ["comer", "to eat"],
    { "cloze": "Yo {{c1::hablo}} español" }
  ]
}`;

function useCopy() {
  const [copied, setCopied] = useState('');
  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(label); setTimeout(() => setCopied(''), 1600); }
    catch { setCopied('Copy failed: select and copy manually'); }
  };
  return { copied, copy };
}

function ApiAccess() {
  const { copied, copy } = useCopy();
  return (
    <div className="panel">
      <div className="panel-head">
        <h3 className="row" style={{ gap: 8 }}><IconKey size={17} /> Let an AI agent add decks</h3>
      </div>
      <p className="muted" style={{ margin: '0 0 14px', fontSize: 14 }}>
        Create an API token in your account, then give your agent the instructions, or connect it over MCP (address and setup on the API tokens page). Tokens can't edit or delete anything.
      </p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Link className="btn primary" to="/account/tokens">Manage API tokens</Link>
        <button className="btn" onClick={() => copy(agentPrompt(window.location.origin, true), 'Agent instructions copied')}>Copy agent instructions</button>
      </div>
      {copied && <div className="toast">{copied}</div>}
    </div>
  );
}

function ResultPanel({ result, onView }: { result: Result; onView: () => void }) {
  if (result.kind === 'anki') {
    const r = result.r;
    return (
      <div className="row">
        <div>
          <b style={{ fontSize: 17 }}>Imported {r.imported.toLocaleString()} cards</b>
          <div className="muted" style={{ fontSize: 14 }}>into {r.decks} deck{r.decks === 1 ? '' : 's'} · {r.media} media files{r.skipped ? ` · ${r.skipped} empty/unsupported skipped` : ''}</div>
        </div>
        <span className="spacer" />
        <button className="btn primary" onClick={onView}>View decks</button>
      </div>
    );
  }
  const r = result.r;
  return (
    <div className="grid" style={{ gap: 10 }}>
      <div className="row">
        <b style={{ fontSize: 17 }}>Added {r.added.toLocaleString()} card{r.added === 1 ? '' : 's'}</b>
        {r.skipped > 0 && <span className="faint">· {r.skipped} already there</span>}
        <span className="spacer" />
        <button className="btn primary" onClick={onView}>View decks</button>
      </div>
      <div className="list" style={{ boxShadow: 'none', background: 'var(--bg-2)' }}>
        {r.decks.map((d) => (
          <Link key={d.deckId} to={`/deck/${d.deckId}`} className="list-row" style={{ padding: '10px 14px' }}>
            <div className="body">
              <div className="title" style={{ fontSize: 15 }}>{d.deck}</div>
              <div className="sub">{d.folder ? `${d.folder.replaceAll('/', ' › ')} · ` : ''}{d.created ? 'new deck' : 'existing deck'}</div>
            </div>
            <span className="mono" style={{ fontSize: 13 }}>+{d.added}{d.skipped ? <span className="faint"> / {d.skipped} skipped</span> : null}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function ImportPage() {
  const [tab, setTab] = useState<'anki' | 'json'>('anki');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState('');
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const nav = useNavigate();
  const { copied, copy } = useCopy();

  const importJsonText = async (raw: string, label: string) => {
    setErr(''); setResult(null);
    let data: unknown;
    try { data = JSON.parse(raw); } catch (e) { return setErr(`That isn't valid JSON: ${(e as Error).message}`); }
    setBusy(label);
    try { setResult({ kind: 'json', r: await api.importJson(data) }); window.dispatchEvent(new Event('recall:library-changed')); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  const handle = async (file?: File) => {
    if (!file) return;
    if (/\.json$/i.test(file.name) || file.type === 'application/json') {
      setTab('json');
      return importJsonText(await file.text(), file.name);
    }
    setErr(''); setResult(null); setBusy(file.name);
    try { setResult({ kind: 'anki', r: await api.importFile(file) }); window.dispatchEvent(new Event('recall:library-changed')); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  };

  // import result / errors, shown right under whatever the user just used
  const feedback = (
    <>
      {err && <div className="panel" style={{ marginTop: tab === 'anki' ? 16 : 0, boxShadow: '0 0 0 1px var(--again)', color: 'var(--again)', whiteSpace: 'pre-wrap', fontSize: 14 }}>{err}</div>}
      {result && (
        <motion.div className="panel" style={{ marginTop: tab === 'anki' ? 16 : 0 }} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <ResultPanel result={result} onView={() => nav('/')} />
        </motion.div>
      )}
    </>
  );

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <section style={{ padding: '30px 0 18px' }}>
        <h1 className="display">Bring your <em>cards</em> in.</h1>
        <p className="muted" style={{ maxWidth: 560 }}>
          Drop an Anki package (<code>.apkg</code>, <code>.colpkg</code>) or a Recall deck <code>.json</code>, for example one written by an AI assistant.
        </p>
      </section>

      <div className="pilltabs" style={{ marginBottom: 16 }}>
        <button className={tab === 'anki' ? 'on' : ''} onClick={() => setTab('anki')}>Anki package</button>
        <button className={tab === 'json' ? 'on' : ''} onClick={() => setTab('json')}>JSON / AI</button>
      </div>

      <motion.div
        className={`dropzone ${over ? 'over' : ''}`}
        style={tab === 'json' ? { padding: '28px 20px' } : undefined}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); handle(e.dataTransfer.files[0]); }}
        onClick={() => input.current?.click()}
        animate={{ scale: over ? 1.015 : 1 }}
      >
        <input ref={input} type="file" accept=".apkg,.colpkg,.json,application/json" hidden onChange={(e) => { handle(e.target.files?.[0]); e.target.value = ''; }} />
        {busy ? (
          <div>
            <motion.div style={{ width: 30, height: 30, margin: '0 auto 12px', borderRadius: '50%', border: '3px solid var(--line-2)', borderTopColor: 'var(--accent)' }} animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }} />
            Importing <b>{busy}</b>…
          </div>
        ) : (
          <div>
            <div style={{ color: 'var(--muted)', marginBottom: 8, display: 'flex', justifyContent: 'center' }}><IconImport size={28} /></div>
            <div style={{ fontSize: 16 }}>Drop a file here, or <span style={{ color: 'var(--accent-2)' }}>browse</span></div>
            <div className="faint" style={{ fontSize: 13, marginTop: 6 }}>
              {tab === 'anki' ? 'In Anki: File → Export → Anki Deck Package' : '.json in the Recall deck format'}
            </div>
          </div>
        )}
      </motion.div>

      {tab === 'json' && (
        <div className="grid" style={{ marginTop: 16, gap: 16 }}>
          <div className="panel">
            <div className="panel-head">
              <h3>Paste JSON</h3>
              <button className="btn sm" onClick={() => copy(agentPrompt(window.location.origin, false), 'Prompt copied: paste it into your AI assistant')}>Copy prompt for AI</button>
            </div>
            <textarea className="textarea" style={{ minHeight: 200 }} placeholder={EXAMPLE} value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) importJsonText(text, 'pasted JSON'); }} />
            <div className="row" style={{ marginTop: 10 }}>
              <span className="faint" style={{ fontSize: 13 }}>
                Cards: <code>{'{"front","back"}'}</code>, <code>["front","back"]</code> or <code>{'{"cloze"}'}</code> · <a href="/recall-deck.schema.json" target="_blank" rel="noreferrer" style={{ color: 'var(--accent-2)' }}>schema</a>
              </span>
              <span className="spacer" />
              <button className="btn primary" disabled={!text.trim() || !!busy} onClick={() => importJsonText(text, 'pasted JSON')}>Import <kbd>⌘↵</kbd></button>
            </div>
          </div>
          {feedback}
          <ApiAccess />
        </div>
      )}

      {tab === 'anki' && feedback}
      {copied && <div className="toast">{copied}</div>}
    </div>
  );
}
