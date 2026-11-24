import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Props = {
  onClose: () => void;
  children: ReactNode;
  /** Heading shown at the top and used as the dialog's accessible name. Leave out to render your own header (pass `label` then). */
  title?: ReactNode;
  /** Accessible name when there's no `title`. */
  label?: string;
  /** Max width in px (default from CSS: 640). */
  width?: number;
  /** Render the dialog as a <form> and call this on submit (preventDefault is done for you). */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  /** CSS class for the dialog box (default "modal"; the command palette uses "palette"). */
  className?: string;
};

/**
 * A dialog over the page: rendered in a portal, closes on Escape or a click on the backdrop,
 * keeps Tab inside itself, locks page scroll, and puts focus back where it was when it closes.
 */
export function Modal({ onClose, children, title, label, width, onSubmit, onKeyDown, className = 'modal' }: Props) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  // read during the first render, before an autoFocus inside the dialog moves focus
  const before = useRef(document.activeElement as HTMLElement | null);

  useEffect(() => {
    const prev = before.current;
    const el = ref.current;
    // autoFocus inside the dialog wins; otherwise focus the dialog itself so Tab starts inside it
    if (el && !el.contains(document.activeElement)) el.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      if (prev?.isConnected) prev.focus();
    };
  }, []);

  const keyDown = (e: KeyboardEvent<HTMLElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key === 'Tab' && ref.current) {
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  // only a press that starts and ends on the backdrop closes, so selecting text and releasing outside doesn't
  const downOnBackdrop = useRef(false);
  const common = {
    ref: ref as never,
    className,
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': title ? titleId : undefined,
    'aria-label': title ? undefined : label,
    tabIndex: -1,
    style: width ? { maxWidth: width } : undefined,
    initial: { opacity: 0, scale: 0.97 },
    animate: { opacity: 1, scale: 1 },
    transition: { duration: 0.16 },
    onKeyDown: keyDown,
  };
  const body = <>{title && <h2 id={titleId}>{title}</h2>}{children}</>;

  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (downOnBackdrop.current && e.target === e.currentTarget) onClose(); downOnBackdrop.current = false; }}
    >
      {onSubmit
        ? <motion.form {...common} onSubmit={(e) => { e.preventDefault(); onSubmit(e); }}>{body}</motion.form>
        : <motion.div {...common}>{body}</motion.div>}
    </div>,
    document.body,
  );
}
