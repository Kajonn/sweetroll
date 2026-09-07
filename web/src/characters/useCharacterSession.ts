import { useEffect, useState, useSyncExternalStore } from "react";
import type { CharacterSession, CharacterSnapshot } from "./session.js";

const loading: CharacterSnapshot = {
  phase: "loading", confirmed: null, tentative: null, entries: [], editing: { owned: false }, error: null, lastRoll: null,
};
const emptySubscribe = () => () => {};
const emptySnapshot = () => loading;

/** Keep the factory stable for an actor/character lifetime; changing it disposes the old session. */
export function useCharacterSession(createSession: () => CharacterSession) {
  const [binding, setBinding] = useState<{ factory: typeof createSession; session: CharacterSession } | null>(null);
  useEffect(() => {
    const session = createSession();
    setBinding({ factory: createSession, session });
    void session.open();
    return () => session.dispose();
  }, [createSession]);
  const session = binding?.factory === createSession ? binding.session : null;
  const snapshot = useSyncExternalStore(session?.subscribe ?? emptySubscribe, session?.getSnapshot ?? emptySnapshot, emptySnapshot);
  return { session, snapshot };
}
