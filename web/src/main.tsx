import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppShell } from "./shell/AppShell.js";
import "./styles/global.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");
createRoot(root).render(
  <StrictMode>
    <AppShell>
      <div data-testid="placeholder">Library coming next</div>
    </AppShell>
  </StrictMode>,
);
