import { useSyncExternalStore } from 'react';
import { Modal } from './Modal';
import { answer, current, subscribe } from './ask';

/** Shows the question from ask(); mount once at the root. */
export function ConfirmHost() {
  const p = useSyncExternalStore(subscribe, current);
  if (!p) return null;
  return (
    <Modal title={p.title} width={420} onClose={() => answer(false)}>
      {p.body && <p className="muted m-0">{p.body}</p>}
      <div className="row justify-end mt-4">
        <button type="button" className="btn ghost" onClick={() => answer(false)} autoFocus={p.danger}>Cancel</button>
        <button type="button" className={`btn ${p.danger ? 'danger-solid' : 'primary'}`} onClick={() => answer(true)} autoFocus={!p.danger}>
          {p.confirm ?? 'Continue'}
        </button>
      </div>
    </Modal>
  );
}
