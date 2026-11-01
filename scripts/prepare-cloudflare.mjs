/* Creates the D1 database and R2 bucket if missing, then points wrangler at
   the account's real D1 id. Runs in GitHub Actions with CLOUDFLARE_API_TOKEN. */
import { readFile, writeFile } from "node:fs/promises";

const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
  process.exit(1);
}

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

const r2 = await api("/r2/buckets");
const buckets = (r2 && r2.buckets) || r2 || [];
if (!buckets.some((item) => item.name === "fleek-avatars")) {
  console.log("Creating R2 bucket fleek-avatars…");
  await api("/r2/buckets", { method: "POST", body: JSON.stringify({ name: "fleek-avatars" }) });
}

const config = JSON.parse(await readFile("wrangler.jsonc", "utf8"));
config.d1_databases = config.d1_databases || [{ binding: "DB", database_name: "fleek" }];
config.d1_databases[0].database_id = database.uuid;
config.r2_buckets = config.r2_buckets || [{ binding: "FILES" }];
config.r2_buckets[0].bucket_name = "fleek-avatars";
await writeFile("wrangler.jsonc", JSON.stringify(config, null, 2) + "\n");

console.log("D1:", database.uuid);
console.log("R2: fleek-avatars");
