import { useEffect, useState } from "react";
import { t } from "../i18n/index.js";
import { Button } from "../ui/index.js";

/** An img element cannot send the scoped credential header. Fetch only the
 * redacted display bytes, then release the object URL on replacement/unmount. */
export function DisplayImage({ path, secret, alt }: { path: string; secret: string; alt: string }) {
  const [image, setImage] = useState<{ path: string; secret: string; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setFailed(false);
    void (async () => {
      try {
        if (!path.startsWith("/displays/")) throw Error("Invalid display image path");
        const response = await fetch(`/api${path}`, {
          headers: { "x-display-secret": secret }, credentials: "omit", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw Error("Display image unavailable");
        const bytes = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(bytes);
        setImage({ path, secret, url: objectUrl });
      } catch {
        if (!controller.signal.aborted) { setImage(null); setFailed(true); }
      }
    })();
    return () => { controller.abort(); if (objectUrl !== null) URL.revokeObjectURL(objectUrl); };
  }, [path, secret, attempt]);
  if (image?.path === path && image.secret === secret && !failed) {
    return <img src={image.url} alt={alt} style={{ display: "block", width: "100%" }} />;
  }
  return <p role="status">{t(failed ? "display.reconnecting.title" : "display.connecting")}{failed ? <> <Button onClick={() => setAttempt(value => value + 1)}>{t("display.retry")}</Button></> : null}</p>;
}
