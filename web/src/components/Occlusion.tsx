// Image occlusion: showing a card (OcclusionView) and drawing the boxes (OcclusionEditor).
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Mask, Occlusion } from '../occlusion';
import { IconTrash } from './Icons';

const pct = (v: number) => `${v * 100}%`;

/**
 * One card of an image occlusion note. `ord` is the box number being tested:
 * on the question it's a solid "?" box; on the answer it's outlined so the image shows through.
 * Other boxes stay covered in "hide all" mode and aren't drawn in "hide one" mode.
 */
export function OcclusionView({ data, ord, side }: { data: Occlusion; ord: number | null; side: 'front' | 'back' }) {
  return (
    <div className="occ">
      <img src={data.image} alt="" draggable={false} />
      {data.masks.map((m, i) => {
        const target = m.n === ord;
        if (!target && data.mode === 'one') return null;
        const cls = !target ? 'other' : side === 'front' ? 'target' : 'revealed';
        return (
          <div key={i} className={`occ-mask ${cls}`} style={{ left: pct(m.x), top: pct(m.y), width: pct(m.w), height: pct(m.h) }}>
            {target && side === 'front' ? '?' : null}
          </div>
        );
      })}
    </div>
  );
}

type Draft = { x0: number; y0: number; x: number; y: number };

/** Upload an image, then drag on it to cover parts with boxes. Each box becomes one card. */
export function OcclusionEditor({ value, onChange }: { value: Occlusion | null; onChange: (o: Occlusion | null) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [over, setOver] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = async (file: File | Blob | null | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return setErr('That isn’t an image.');
    setBusy(true); setErr('');
    try {
      const { url } = await api.uploadImage(file, (file as File).name || 'pasted.png');
      onChange({ image: url, mode: value?.mode ?? 'one', masks: [] });
      setSelected(null);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // paste an image from the clipboard (screenshots!) while the editor is open
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      if (item) { e.preventDefault(); upload(item.getAsFile()); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  const point = (e: React.PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const setMasks = (masks: Mask[]) => value && onChange({ ...value, masks });
  const removeMask = (i: number) => { if (!value) return; setMasks(value.masks.filter((_, j) => j !== i)); setSelected(null); };

  if (!value) {
    return (
      <div
        className={`dropzone occ-drop ${over ? 'over' : ''}`}
        onClick={() => fileInput.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files[0]); }}
      >
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" hidden onChange={(e) => upload(e.target.files?.[0])} />
        <b>{busy ? 'Uploading…' : 'Choose an image'}</b>
        <div className="faint" style={{ fontSize: 13, marginTop: 4 }}>or drop one here, or paste a screenshot</div>
        {err && <div className="form-error" style={{ marginTop: 8 }}>{err}</div>}
      </div>
    );
  }

  const nextNumber = Math.max(0, ...value.masks.map((m) => m.n)) + 1;
  const d = draft && { x: Math.min(draft.x0, draft.x), y: Math.min(draft.y0, draft.y), w: Math.abs(draft.x - draft.x0), h: Math.abs(draft.y - draft.y0) };

  return (
    <div className="grid" style={{ gap: 10 }}>
      <div className="occ-tools">
        <div className="kind-switch">
          <button type="button" className={value.mode === 'one' ? 'on' : ''} onClick={() => onChange({ ...value, mode: 'one' })} title="Only the tested box is covered">Hide one</button>
          <button type="button" className={value.mode === 'all' ? 'on' : ''} onClick={() => onChange({ ...value, mode: 'all' })} title="Every box is covered; one is the question">Hide all, guess one</button>
        </div>
        <span className="spacer" />
        {selected != null && <button type="button" className="btn sm danger" onClick={() => removeMask(selected)}><IconTrash size={14} /> Remove box</button>}
        <button type="button" className="btn sm ghost" onClick={() => fileInput.current?.click()}>Replace image</button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" hidden onChange={(e) => upload(e.target.files?.[0])} />
      </div>
      <div className="occ-stage">
      <div
        ref={stage}
        className="occ occ-edit"
        tabIndex={0}
        onKeyDown={(e) => { if ((e.key === 'Delete' || e.key === 'Backspace') && selected != null) { e.preventDefault(); removeMask(selected); } }}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('.occ-mask')) return;
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
          const p = point(e);
          setDraft({ x0: p.x, y0: p.y, x: p.x, y: p.y });
          setSelected(null);
        }}
        onPointerMove={(e) => { if (draft) { const p = point(e); setDraft({ ...draft, x: p.x, y: p.y }); } }}
        onPointerUp={() => {
          if (d && d.w > 0.01 && d.h > 0.01) {
            setMasks([...value.masks, { x: d.x, y: d.y, w: d.w, h: d.h, n: nextNumber }]);
            setSelected(value.masks.length);
          }
          setDraft(null);
        }}
        onPointerCancel={() => setDraft(null)}
      >
        <img src={value.image} alt="" draggable={false} />
        {value.masks.map((m, i) => (
          <div key={i} className={`occ-mask edit ${selected === i ? 'sel' : ''}`} style={{ left: pct(m.x), top: pct(m.y), width: pct(m.w), height: pct(m.h) }}
            onPointerDown={(e) => { e.stopPropagation(); setSelected(i); stage.current?.focus(); }}>
            {m.n}
          </div>
        ))}
        {d && <div className="occ-mask draft" style={{ left: pct(d.x), top: pct(d.y), width: pct(d.w), height: pct(d.h) }} />}
      </div>
      </div>
      <div className="faint" style={{ fontSize: 13 }}>
        {value.masks.length
          ? `${value.masks.length} box${value.masks.length === 1 ? '' : 'es'} · one card each. Drag to add more, tap a box to select it.`
          : 'Drag over the parts of the image to hide. Each box becomes a card.'}
        {busy && ' Uploading…'}
      </div>
      {err && <div className="form-error">{err}</div>}
    </div>
  );
}
