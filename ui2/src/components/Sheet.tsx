// ui2/src/components/Sheet.tsx — bottom sheet: chat drawer + mobile inspectors. Stays mounted (content survives).
import type { ReactNode } from "react";

export function Sheet({ open, onClose, children, tall }: {
  open: boolean; onClose: () => void; children: ReactNode; tall?: boolean;
}) {
  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />}
      <div
        className={`fixed left-0 right-0 bottom-0 z-50 bg-surface border-t border-line rounded-t-lg
          transition-transform duration-200 flex flex-col ${tall ? "h-[85vh]" : "h-[min(480px,70vh)]"}
          ${open ? "translate-y-0" : "translate-y-full pointer-events-none"}`}
      >
        {children}
      </div>
    </>
  );
}
