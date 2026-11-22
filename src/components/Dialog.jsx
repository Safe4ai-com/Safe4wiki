import { useEffect, useRef } from 'react';
import { XIcon } from './Icons.jsx';

const dialogStack = [];

export default function Dialog({ title, onClose, children, footer, wide, nested }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const token = {};
    dialogStack.push(token);
    const esc = e => {
      if (e.key === 'Escape' && dialogStack[dialogStack.length - 1] === token) {
        e.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('keydown', esc);
      const idx = dialogStack.lastIndexOf(token);
      if (idx !== -1) dialogStack.splice(idx, 1);
    };
  }, []);

  return (
    <div className={`overlay${nested ? ' nested' : ''}`} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
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
