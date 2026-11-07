import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Account } from "./Account.js";
import type { ApiClient } from "../api/client.js";
import { setDebugMode } from "../ui/debugMode.js";

afterEach(() => { act(() => setDebugMode(false)); localStorage.clear(); });

it("has one device theme control and exposes IDs only after opting into debug", async () => {
  const client = { fetch: vi.fn(async (_method, path) => path === "/me" ? { state: "authenticated", userId: "private-account-id" } : { theme_default: null }) } as unknown as ApiClient;
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={query}><Account client={client} identity={{ getActorId: () => "private-account-id", isOnline: () => true, signOut: vi.fn() }} storageUnavailable={false} /></QueryClientProvider>);
  expect(await screen.findByText("This device")).toBeVisible();
  expect(screen.queryByText("private-account-id")).not.toBeInTheDocument();
  expect(screen.getAllByRole("combobox", { name: "Theme" })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
  expect(screen.queryByText("Open a character to archive or recover it.")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Developer tools"));
  fireEvent.click(screen.getByRole("checkbox", { name: "Show debug information" }));
  expect(screen.getAllByText("private-account-id")).toHaveLength(1);
});

it("creates and revokes a scoped API token and only shows its secret on creation", async () => {
  const secret = "sr_pat_test_only";
  const token = { id: "token-id", label: "My script", scopes: ["systems:read"], expiresAt: "2026-11-20T12:00:00Z" };
  const fetch = vi.fn(async (method, path) => {
    if (path === "/me") return { state: "authenticated", userId: "account" };
    if (path === "/me/preferences") return { theme_default: null };
    if (method === "POST") return { ...token, token: secret };
    return { enabled: true, tokens: [] };
  });
  const client = { fetch } as unknown as ApiClient;
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={query}><Account client={client} identity={{ getActorId: () => "account", isOnline: () => true, signOut: vi.fn() }} storageUnavailable={false} /></QueryClientProvider>);
  fireEvent.click(await screen.findByText("API tokens"));
  fireEvent.change(screen.getByRole("textbox", { name: "Token label" }), { target: { value: "My script" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Read systems" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Read campaigns" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Write campaigns" }));
  fireEvent.click(screen.getByRole("button", { name: "Create token" }));
  expect(await screen.findByDisplayValue(secret)).toBeVisible();
  expect(fetch).toHaveBeenCalledWith("POST", "/me/personal-tokens", {
    body: { label: "My script", scopes: ["systems:read", "campaigns:read", "campaigns:write"], expiresInDays: 30 },
  });
  fireEvent.click(screen.getByRole("button", { name: "Hide token secret" }));
  expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Revoke My script" })));
  expect(fetch).toHaveBeenCalledWith("DELETE", "/me/personal-tokens/token-id");
});
