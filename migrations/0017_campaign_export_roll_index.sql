-- I6 campaign export roll index (final fix wave): supports
-- loadVisibleRollsForExport, which filters
-- WHERE r.scope_campaign_id = $3 with ORDER BY r.id LIMIT. Plain CREATE
-- INDEX (migrations run one-transaction each; no CONCURRENTLY). This file
-- must not be edited once applied.

CREATE INDEX character_rolls_scope_campaign_page_idx
  ON character_rolls (scope_campaign_id, id);
