// ui/src/components/ConfirmButton.tsx — two-step arm/confirm; disarms after 4s of inaction.
import { useEffect, useState } from "react";

export function ConfirmButton({ label, confirmLabel, alert, disabled, onConfirm, className }: {
  label: string; confirmLabel?: string; alert?: boolean; disabled?: boolean;
  onConfirm: () => void; className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const color = alert
    ? "border-alert text-alert hover:bg-alert"
    : "border-phosphor text-phosphor hover:bg-phosphor";
  return (
    <button
      disabled={disabled}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}
      className={`border px-3 py-1 font-display uppercase tracking-[0.2em] text-[10px] hover:text-void transition-colors disabled:opacity-40 ${color} ${className ?? ""}`}
    >
      {armed ? (confirmLabel ?? `confirm ${label}?`) : label}
    </button>
  );
}
