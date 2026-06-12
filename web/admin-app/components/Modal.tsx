// Generic modal: backdrop + panel, Escape to close, scroll-locked body.

import { useEffect, useRef } from "react";

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  xwide?: boolean;
  workspace?: boolean;
}

export function Modal({ title, onClose, children, wide, xwide, workspace }: Props): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  // Only treat a backdrop click as "close" when the press STARTED on the
  // backdrop too. Otherwise pressing inside a field and dragging the cursor out
  // before releasing (e.g. selecting text) fires a click whose target is the
  // backdrop and would wrongly dismiss the modal.
  const pressOnBackdrop = useRef(false);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        pressOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressOnBackdrop.current) onClose();
      }}
    >
      <div
        className={`modal-panel ${wide ? "modal-panel--wide" : ""} ${xwide ? "modal-panel--xwide" : ""} ${workspace ? "modal-panel--workspace" : ""}`}
        role="dialog"
        aria-modal="true"
      >
        <header className="modal-head">
          <h3>{title}</h3>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function ProgressBar({ current, total }: { current: number; total: number }): JSX.Element {
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  return (
    <span className="progress" title={`${current} / ${total}`}>
      <span className="progress__bar" style={{ width: `${pct}%` }} />
      <span className="progress__label">
        {total > 0 ? `${pct}%` : "—"}
      </span>
    </span>
  );
}
