import { useEffect, useState, type FormEvent } from "react";

import type { ApiClient } from "../api/client.js";
import { t } from "../i18n/index.js";
import { Button, Checkbox, FormField, Select } from "../ui/index.js";
import { Disclosure } from "../ui/Disclosure.js";

const path = "/me/personal-tokens";
const scopes = [
  "systems:read", "systems:write", "characters:read", "characters:write", "campaigns:read", "campaigns:write",
] as const;
type Scope = (typeof scopes)[number];
type Token = { id: string; label: string; scopes: Scope[]; expiresAt: string };
type TokenList = { enabled: boolean; tokens: Token[] };

export function PersonalTokens({ client, online }: { client: ApiClient; online: boolean }) {
  const [available, setAvailable] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState<Scope[]>([]);
  const [days, setDays] = useState("30");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!online) return;
    const controller = new AbortController();
    void client.fetch<TokenList>("GET", path, { signal: controller.signal }).then(
      (result) => {
        if (controller.signal.aborted) return;
        setAvailable(result.enabled === true);
        setTokens(result.tokens ?? []);
        setFailed(false);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [client, online]);

  useEffect(() => {
    const clearSecret = () => setSecret(null);
    window.addEventListener("pagehide", clearSecret);
    return () => window.removeEventListener("pagehide", clearSecret);
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !online || label.trim() === "" || selected.length === 0) return;
    setPending(true);
    setFailed(false);
    setSecret(null);
    try {
      const { token, ...metadata } = await client.fetch<Token & { token: string }>("POST", path, {
        body: { label: label.trim(), scopes: selected, expiresInDays: Number(days) },
      });
      setTokens((previous) => [metadata, ...previous]);
      setSecret(token);
      setLabel("");
      setSelected([]);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  async function revoke(id: string) {
    if (pending || !online) return;
    setPending(true);
    setFailed(false);
    setSecret(null);
    try {
      await client.fetch("DELETE", `${path}/${id}`);
      setTokens((previous) => previous.filter((token) => token.id !== id));
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  if (!available && !failed) return null;

  return (
    <Disclosure label={t("account.tokens.title")}>
      {failed && <p role="alert">{t("account.tokens.failed")}</p>}
      {available && <>
        {tokens.length === 0 ? <p>{t("account.tokens.empty")}</p> : <ul>
          {tokens.map((token) => (
            <li key={token.id}>
              <strong>{token.label}</strong>
              <p>{token.scopes.map((scope) => t(`account.tokens.scope.${scope}`)).join(", ")}</p>
              <p>{t("account.tokens.expires", { date: new Date(token.expiresAt).toLocaleDateString() })}</p>
              <Button type="button" variant="secondary" disabled={pending || !online} onClick={() => void revoke(token.id)}>
                {t("account.tokens.revoke", { label: token.label })}
              </Button>
            </li>
          ))}
        </ul>}
        {secret !== null && online && <div>
          <FormField label={t("account.tokens.secret")} hint={t("account.tokens.secretHint")}>
            <input value={secret} readOnly autoComplete="off" spellCheck={false} onFocus={(event) => event.currentTarget.select()} />
          </FormField>
          <Button type="button" variant="secondary" onClick={() => setSecret(null)}>{t("account.tokens.hide")}</Button>
        </div>}
        <form onSubmit={(event) => void create(event)}>
          <fieldset disabled={pending || !online}>
            <legend>{t("account.tokens.new")}</legend>
            <FormField label={t("account.tokens.label")}>
              <input required maxLength={80} value={label} onChange={(event) => setLabel(event.currentTarget.value)} />
            </FormField>
            <Select label={t("account.tokens.expiration")} value={days} onChange={(event) => setDays(event.currentTarget.value)}
              options={["7", "30", "90"].map((value) => ({ value, label: t("account.tokens.days", { days: value }) }))} />
            {scopes.map((scope) => {
              // A write scope includes read for the same area; show read as included.
              const implied = scope.endsWith(":read") && selected.includes(scope.replace(/:read$/, ":write") as Scope);
              return (
              <Checkbox key={scope} label={t(`account.tokens.scope.${scope}`)} checked={implied || selected.includes(scope)}
                disabled={implied} hint={implied ? t("account.tokens.includedByWrite") : undefined}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setSelected((previous) => checked ? [...previous, scope] : previous.filter((value) => value !== scope));
                }} />
              );
            })}
            <Button type="submit" variant="primary" disabled={label.trim() === "" || selected.length === 0}>
              {t("account.tokens.create")}
            </Button>
          </fieldset>
        </form>
      </>}
    </Disclosure>
  );
}
