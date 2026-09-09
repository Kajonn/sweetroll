import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";

import { queryClient } from "./queryClient.js";
import { router } from "./router.js";
import { registerOfflineWorker } from "./offline/register.js";
import { initTheme } from "./theme/theme.js";
import "./styles/global.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element");
// Device theme preference (G2-structural): applies the stored preference now
// and keeps Follow-device in sync with OS changes and cross-tab updates.
// The before-paint inline script in index.html already handled first paint.
initTheme();
// Production asset worker only; registration resolves without throwing.
void registerOfflineWorker();
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
