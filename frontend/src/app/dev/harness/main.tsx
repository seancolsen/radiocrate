import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../../app.css";

// The React port's visual-test harness, served at `/react-harness.html?story=<id>`.
// A placeholder until stage 2 ports `src/dev/harness/main.tsx` over the React
// stores; for now it only proves the React tree builds and mounts alongside the
// Solid one.

function Placeholder() {
  return (
    <div data-testid="story" className="bg-panel text-ink p-4 text-xs">
      React harness placeholder
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>,
);
