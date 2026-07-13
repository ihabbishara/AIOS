// ui2/src/components/TwoStepButton.tsx — two-step arm/confirm (successor of ui/ ConfirmButton); disarms after 4s.
import { useEffect, useState } from "react";

export function TwoStepButton({ label, confirmLabel, disabled, onConfirm, className = "" }: {
  label: string; confirmLabel?: string; disabled?: boolean; onConfirm: () => void; className?: string;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      disabled={disabled}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}
      className={`border rounded-md px-3 py-1.5 text-[12px] transition-colors disabled:opacity-40 ${
        armed ? "border-err text-err" : "border-line text-dim hover:text-err hover:border-err"
      } ${className}`}
    >
      {armed ? (confirmLabel ?? `confirm ${label}?`) : label}
    </button>
  );
}
