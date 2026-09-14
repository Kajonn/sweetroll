import { useState } from "react";

import type { ApiClient } from "../api/client.js";
import type { SystemSummary } from "../api/server.js";
import { useChangeSharing, type SharingValue } from "../api/sharing.js";
import { t } from "../i18n/index.js";
import { Button, Dialog, Select } from "../ui/index.js";

const ORDER: SharingValue[] = ["private", "link", "public"];

function widens(from: string, to: SharingValue): boolean {
  return ORDER.indexOf(to) > ORDER.indexOf(from as SharingValue);
}

export function SystemSharing({ client, system }: { client: ApiClient; system: SystemSummary }) {
  const mutation = useChangeSharing(client);
  const [confirm, setConfirm] = useState<SharingValue | null>(null);

  const apply = (access: SharingValue) => {
    mutation.mutate(
      { systemId: system.systemId, access },
      { onSuccess: () => setConfirm(null) },
    );
  };

  const onSelect = (value: string) => {
    const access = value as SharingValue;
    if (access === system.access) return;
    if (widens(system.access, access)) {
      setConfirm(access);
      return;
    }
    apply(access);
  };

  return (
    <>
      <Select
        label={t("library.sharing.label").replace("{name}", system.name)}
        options={[
          { value: "private", label: t("library.sharing.private") },
          { value: "link", label: t("library.sharing.link") },
          { value: "public", label: t("library.sharing.public") },
        ]}
        value={system.access}
        onChange={(e) => onSelect(e.target.value)}
        pending={mutation.isPending}
        {...(mutation.isPending ? { hint: t("library.sharing.pending") } : {})}
        {...(mutation.isError ? { error: t("library.sharing.failed") } : {})}
        data-testid={`system-sharing-${system.systemId}`}
      />
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={t("library.sharing.confirmTitle").replace("{name}", system.name)}
        description={
          confirm === "public" ? t("library.sharing.confirmPublic") : t("library.sharing.confirmLink")
        }
        actions={
          confirm !== null ? (
            <Button
              variant="primary"
              disabled={mutation.isPending}
              onClick={() => apply(confirm)}
            >
              {confirm === "public" ? t("library.sharing.confirmPublicButton") : t("library.sharing.confirm")}
            </Button>
          ) : undefined
        }
      >
        <p>{t("library.sharing.label").replace("{name}", system.name)}</p>
      </Dialog>
    </>
  );
}
