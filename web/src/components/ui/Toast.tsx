import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A short message at the bottom of the screen that clears itself.
 * `toast` is the element to render (null when there's nothing to show); `show(msg)` puts up a message.
 */
export function useToast(ms = 1600) {
  const [msg, setMsg] = useState('');
  const [n, setN] = useState(0); // bumps on every show, so the same message twice restarts the timer
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(''), ms);
    return () => clearTimeout(t);
  }, [msg, n, ms]);
  const show = useCallback((m: string) => { setMsg(m); setN((x) => x + 1); }, []);
  const toast = msg ? createPortal(<div className="toast" role="status" aria-live="polite">{msg}</div>, document.body) : null;
  return { toast, show };
}

/** Copy text to the clipboard and say so in a toast. */
export function useCopy() {
  const { toast, show } = useToast();
  const copy = useCallback(async (text: string, label = 'Copied') => {
    try { await navigator.clipboard.writeText(text); show(label); }
    catch { show('Copy failed: select it and copy manually'); }
  }, [show]);
  return { toast, copy };
}
