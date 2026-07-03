import { useEffect, useState, type ReactElement } from "react";

// Increment-1 shell-boot proof: renders the hardened renderer and exercises the
// narrow preload bridge. The Global Today surface (9.4) replaces this next.
export function App(): ReactElement {
  const [version, setVersion] = useState<string>("…");

  useEffect(() => {
    void window.sow.app.getVersion().then(setVersion);
  }, []);

  return (
    <div className="boot">
      <h1>System of Work</h1>
      <p>macOS Liquid Glass shell — hardened renderer online.</p>
      <p className="mono">app v{version}</p>
    </div>
  );
}
