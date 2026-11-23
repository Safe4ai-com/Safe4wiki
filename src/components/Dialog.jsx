import { useEffect, useRef } from 'react';
import { XIcon } from './Icons.jsx';

const dialogStack = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export default function Dialog({ title, onClose, children, footer, wide, nested }) {
  const closeRef = useRef(onClose);
  const boxRef = useRef(null);
  closeRef.current = onClose;

  useEffect(() => {
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const token = {};
    dialogStack.push(token);

    // Move initial keyboard focus inside the dialog if it isn't already there.
    const box = boxRef.current;
    if (box && !box.contains(document.activeElement)) {
      const first = box.querySelector(FOCUSABLE);
      if (first instanceof HTMLElement) first.focus();
      else box.focus();
    }

    const onKeyDown = e => {
      if (dialogStack[dialogStack.length - 1] !== token) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key === 'Tab' && boxRef.current) {
        const nodes = [...boxRef.current.querySelectorAll(FOCUSABLE)]
          .filter(el => el instanceof HTMLElement && el.offsetParent !== null);
        if (!nodes.length) {
          e.preventDefault();
          boxRef.current.focus();
          return;
        }
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first || !boxRef.current.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else if (document.activeElement === last || !boxRef.current.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const idx = dialogStack.lastIndexOf(token);
      if (idx !== -1) dialogStack.splice(idx, 1);
      if (prevFocus && document.contains(prevFocus)) {
        try { prevFocus.focus(); } catch { /* ignore */ }
      }
    };
  }, []);

  return (
    <div className={`overlay${nested ? ' nested' : ''}`} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={boxRef} tabIndex={-1} className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><XIcon /></button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function NeedsServer({ onClose, what }) {
  return (
    <Dialog title="Start the Safe4wiki app" onClose={onClose} footer={<button type="button" className="btn" onClick={onClose}>Close</button>}>
      <p style={{ marginTop: 0 }}>{what} runs on your own computer, through the Safe4wiki app.</p>
      <p>On Mac, double-click <strong>Open Safe4wiki.command</strong> in the app folder. It opens Safe4wiki at <code>http://localhost:4317</code>. Keep the Terminal window open while you work.</p>
      <p>On other systems, follow the setup instructions and run <code>npm start</code> from the app folder.</p>
    </Dialog>
  );
}
