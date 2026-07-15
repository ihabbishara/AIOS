// ui2/src/components/TokenGate.tsx — 401 gate (existing behavior kept; Ember styling).
import { useState } from "react";
import { getToken, setToken } from "../api.js";
import { Button } from "./ui.js";

export function TokenGate({ onSet }: { onSet: () => void }) {
  const [value, setValue] = useState(getToken());
  const submit = () => { setToken(value); onSet(); };
  return (
    <div className="h-full flex items-center justify-center">
      <div className="panel w-80 p-6">
        <div className="text-strong text-[15px] mb-1">AIOS</div>
        <div className="label mb-5">Access token required</div>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="AIOS_UI_TOKEN"
          className="w-full bg-bg border border-line rounded-md px-3 py-2 text-fg outline-none focus:border-dim"
        />
        <Button variant="primary" className="mt-4 w-full" onClick={submit}>Unlock</Button>
      </div>
    </div>
  );
}
