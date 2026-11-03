import { createApiClient } from "../api/client.js";
import { createIdentityGate } from "../characters/identity.js";
import { openCharacterStore } from "../characters/store.js";

/** Complete ordinary sign-out (including durable private-data purge and
 * cross-tab notification) before a formerly private device can pair. */
export async function prepareDisplayContext(): Promise<void> {
  const store = await openCharacterStore("sweetroll-characters");
  const gate = createIdentityGate({ store, client: createApiClient({ baseUrl: "/api" }) });
  try {
    await gate.signOut();
    if (gate.getSnapshot().pendingLogout) throw Error("Display entry requires confirmed sign-out");
  } finally { gate.dispose(); await store.close(); }
}
