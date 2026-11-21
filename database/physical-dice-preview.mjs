import pg from "pg";

const [mode] = process.argv.slice(2);
if (process.env.RAILWAY_SERVICE_NAME !== "sweetroll-acceptance" || process.env.SWEETROLL_TEST_AUTH !== "1") {
  throw Error("This branch can only start on the existing Sweetroll acceptance service.");
}
if (mode !== "init" && mode !== "serve") throw Error("Expected init or serve.");
const name = "sweetroll_dice_acceptance_20261121";
const preview = new URL(process.env.DATABASE_URL);
if (mode === "init") {
  const admin = new pg.Client({ connectionString: preview.href });
  await admin.connect();
  try {
    const found = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]);
    if (!found.rowCount) await admin.query('CREATE DATABASE "sweetroll_dice_acceptance_20261121"');
    console.log("Physical dice acceptance database is available.");
  } finally {
    await admin.end();
  }
}
preview.pathname = "/" + name;
process.env.DATABASE_URL = preview.href;
process.env.SWEETROLL_PHYSICAL_DICE = "true";
if (mode === "init") await import("../dist/bootstrap/initialize-database.js");
else await import("../dist/bootstrap/http.js");
