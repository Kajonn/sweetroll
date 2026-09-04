import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/global.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");
createRoot(root).render(<StrictMode><div data-testid="app-ready">Sweetroll</div></StrictMode>);
