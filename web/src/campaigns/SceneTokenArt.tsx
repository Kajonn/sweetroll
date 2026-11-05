import { useState } from "react";

/** GM-authorized art. A missing file must never hide the token's readable label. */
export function SceneTokenArt({ campaignId, fileId, label }: { campaignId: string; fileId: string; label: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return <img src={`/api/campaigns/${encodeURIComponent(campaignId)}/images/${encodeURIComponent(fileId)}/original`} alt={label} onError={() => setFailed(true)} />;
}
