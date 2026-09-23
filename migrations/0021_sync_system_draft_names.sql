-- The editor edits document metadata, while system lists and creation-version
-- catalogs read systems.name. Reconcile drafts saved before these two names
-- were updated in the same transaction.
UPDATE systems AS s
   SET name = d.document_json->'metadata'->>'name',
       updated_at = now()
  FROM system_drafts AS d
 WHERE d.system_id = s.id
   AND jsonb_typeof(d.document_json->'metadata'->'name') = 'string'
   AND btrim(d.document_json->'metadata'->>'name') <> ''
   AND s.name IS DISTINCT FROM d.document_json->'metadata'->>'name';
