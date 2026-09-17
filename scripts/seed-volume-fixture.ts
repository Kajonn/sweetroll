// Seeds a production-like volume into a SCRATCH database only.
// Usage: TEST_DATABASE_URL=... npx tsx scripts/seed-volume-fixture.ts [campaigns=20 charactersPerCampaign=50]
// Never point at the dev `sweetroll` database; the drill doc requires sweetroll_drill_* targets.
import { Pool } from "pg";

const url = process.env.TEST_DATABASE_URL ?? "";
if (!url || /\/sweetroll(\?|$)/.test(url)) {
  console.error("refusing: TEST_DATABASE_URL must be a sweetroll_drill_* scratch database");
  process.exit(1);
}
const campaigns = Number(process.argv[2] ?? 20);
const perCampaign = Number(process.argv[3] ?? 50);
const pool = new Pool({ connectionString: url });
const owner = "00000000-0000-0000-0000-000000000001";
await pool.query(`INSERT INTO users (id, display_name) VALUES ($1, 'vol-drill') ON CONFLICT (id) DO NOTHING`, [owner]);
for (let c = 0; c < campaigns; c++) {
  const camp = await pool.query(
    `INSERT INTO campaigns (owner_id, system_version_id, title, status) VALUES ($1, (SELECT id FROM system_versions LIMIT 1), $2, 'active') RETURNING id`,
    [owner, `vol-drill-${c}`],
  );
  const campId: string = camp.rows[0].id;
  for (let i = 0; i < perCampaign; i++) {
    await pool.query(
      `INSERT INTO characters (owner_id, campaign_id, system_version_id, entity_definition_id, name, revision, state_json) VALUES (NULL, $1, (SELECT id FROM system_versions LIMIT 1), 'vol-drill', $2, 1, $3)`,
      [campId, `vol-drill-${c}-${i}`, JSON.stringify({ name: `vol-drill-${c}-${i}` })],
    );
  }
}
await pool.end();
console.log(`seeded campaigns=${campaigns} perCampaign=${perCampaign}`);
