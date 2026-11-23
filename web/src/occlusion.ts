// Image occlusion notes: an uploaded image with boxes over it; each box number is one card.
// Stored as JSON in the card's front (see server/cloze.js for the server-side validation).
export type Mask = { x: number; y: number; w: number; h: number; n: number };
export type Occlusion = { image: string; mode: 'one' | 'all'; masks: Mask[] };

export function parseOcclusion(front: string): Occlusion | null {
  try {
    const o = JSON.parse(front);
    return o && typeof o.image === 'string' && Array.isArray(o.masks) ? { image: o.image, mode: o.mode === 'all' ? 'all' : 'one', masks: o.masks } : null;
  } catch { return null; }
}

export const occlusionNumbers = (o: Occlusion | null) => (o ? [...new Set(o.masks.map((m) => m.n))].sort((a, b) => a - b) : []);
