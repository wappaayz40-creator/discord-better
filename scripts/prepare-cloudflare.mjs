/* Creates the D1 database if missing, then points wrangler at the account's
   real D1 id. Runs in GitHub Actions with CLOUDFLARE_API_TOKEN.
   R2 is optional; without it the app deploys D1-only and upload routes return
   "storage is not configured". */
import { readFile, writeFile } from "node:fs/promises";

const token = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
const account = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
if (!token || !account) {
  console.error("Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID repository secret.");
  process.exit(1);
}
if (!/^[0-9a-f]{32}$/i.test(account)) {
  console.error("CLOUDFLARE_ACCOUNT_ID must be exactly 32 hex characters (no URL, no spaces).");
  process.exit(1);
}
console.log("Cloudflare token length:", token.length, "account id length:", account.length);

const api = async (path, init = {}) => {
  const res = await fetch("https://api.cloudflare.com/client/v4/accounts/" + account + path, {
    ...init,
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const detail = (data.errors || []).map((e) => e.message).join("; ") || res.status;
    throw new Error(path + " failed: " + detail);
  }
  return data.result;
};

const databases = await api("/d1/database");
let database = (databases || []).find((item) => item.name === "fleek");
if (!database) {
  console.log("Creating D1 database fleek…");
  database = await api("/d1/database", { method: "POST", body: JSON.stringify({ name: "fleek" }) });
}
if (!database || !database.uuid) throw new Error("Could not determine the D1 database id.");

const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
config.d1_databases = config.d1_databases || [{ binding: "DB", database_name: "fleek" }];
config.d1_databases[0].database_id = database.uuid;
delete config.r2_buckets;
await writeFile("wrangler.jsonc", JSON.stringify(config, null, 2) + "\n");

console.log("D1:", database.uuid);
console.log("R2: not configured (deploying D1-only; uploads disabled)");
