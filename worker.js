/* ============================================================
   Fleek · Cloudflare Worker
   Static client + JSON API on D1 and R2.

   Accounts are handle + password (PBKDF2-SHA256, random salt,
   hashed session tokens in HttpOnly cookies). Community data is
   shaped like Discord: users create servers, servers own text
   channels, messages belong to a channel, and DMs are separate.
   ============================================================ */

const HANDLE_RE = /^[a-z0-9_]{2,24}$/;
const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const CHANNEL_TYPES = new Set(["text", "voice", "forum", "announcement", "rules"]);
const MAX_BODY = 2000;
const MAX_POST = 4000;
const VOICE_STALE_MS = 45 * 1000;
const SIGNAL_MAX = 24000;
const MAX_UPLOAD = 10 * 1024 * 1024;
const BLOCKED_UPLOAD_MIMES = new Set([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "application/javascript",
  "text/javascript",
]);

// Server permissions, stored as a bitmask on roles.
const PERM = { MANAGE_CHANNELS: 1, MANAGE_ROLES: 2, ANNOUNCE: 4 };
const STATUS_MAX = 80;

/* The official Fleeks server every account joins, owned by a bot that can't
   sign in. Ids are fixed so concurrent isolates seed the same rows. */
const OFFICIAL_SERVER_ID = "0f1c1a11-0000-4000-8000-f1ee50000001";
const OFFICIAL_BOT_SUB = "0f1c1a11-0000-4000-8000-f1ee50000002";

const NAME_FONTS = new Set(["", "inter", "georgia", "arialblack", "verdana", "trebuchet", "courier", "impact", "comic", "palatino"]);

const OFFICIAL_RULES = [
  "Be decent to people. No harassment, hate speech, or targeting anyone.",
  "No spam, mass mentions, or flooding channels.",
  "Keep NSFW, gore and illegal content out of Fleeks.",
  "Post in the channel that fits: help in #help, media in #media, bots in #bot-commands.",
  "No advertising or invite dumping without asking a moderator.",
  "Staff decisions are final. If you disagree, message staff privately instead of arguing in chat.",
  "Have fun. This is a small community and the rules exist so it stays that way.",
].join("\n");

const OFFICIAL_CHANNELS = [
  { name: "welcome", type: "text", category: "START HERE", topic: "New here? Start with this and the rules." },
  { name: "rules", type: "rules", category: "START HERE", topic: "Read before you post." },
  { name: "announcements", type: "announcement", category: "START HERE", topic: "Fleek news, posted by the bot." },
  { name: "general", type: "text", category: "TEXT CHANNELS", topic: "Anything and everything." },
  { name: "introductions", type: "text", category: "TEXT CHANNELS", topic: "Say hi and tell us what you're into." },
  { name: "off-topic", type: "text", category: "TEXT CHANNELS", topic: "Random thoughts live here." },
  { name: "help", type: "text", category: "TEXT CHANNELS", topic: "Ask questions about Fleek or anything else." },
  { name: "suggestions", type: "text", category: "TEXT CHANNELS", topic: "Ideas that would make Fleek better." },
  { name: "media", type: "text", category: "COMMUNITY", topic: "Art, clips, screenshots and links." },
  { name: "forum", type: "forum", category: "COMMUNITY", topic: "Longer posts and guides." },
  { name: "bot-commands", type: "text", category: "COMMUNITY", topic: "Webhooks and bot output." },
  { name: "logs", type: "text", category: "COMMUNITY", topic: "Server activity.", logs: true },
  { name: "General", type: "voice", category: "VOICE", topic: "Hop in and talk." },
  { name: "Lounge", type: "voice", category: "VOICE", topic: "Chill with music or nothing at all." },
  { name: "Music", type: "voice", category: "VOICE", topic: "Share what you're listening to." },
];
const PROFILE_TEXT_MAX = 8000;
// One-shot cleanup key; the route that uses it is removed in the next deploy.
const STARTER_RULES = [
  "Be kind. No harassment, hate speech or slurs.",
  "Keep it on topic and take long conversations to DMs.",
  "No spam, self-promo or invite dumping without permission.",
  "Ask before sharing someone else's private information.",
  "Follow the owner's calls on moderation.",
].join("\n");
const ONLINE_MS = 2 * 60 * 1000;
const TOUCH_MS = 60 * 1000;
const COOKIE_NAME = "fleek_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100000; // workerd caps PBKDF2 at 100k iterations
const MAX_ATTEMPTS = 25;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const RESERVED = new Set([
  "admin", "administrator", "fleek", "system", "support", "mod", "moderator",
  "staff", "official", "help", "root", "everyone", "here",
]);

let schemaReady = false;

/* ----------------------------------------------------------
   Responses, encoding, cookies
   ---------------------------------------------------------- */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      ...headers,
    },
  });
}

function fail(message, status = 400) {
  return json({ error: message }, status);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomToken(bytesCount) {
  const bytes = crypto.getRandomValues(new Uint8Array(bytesCount || 32));
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function inviteCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    key,
    256
  );
  return bytesToBase64(new Uint8Array(bits));
}

function constantTimeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  let diff = left.length === right.length ? 0 : 1;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function parseCookies(header) {
  const jar = {};
  String(header || "")
    .split(";")
    .forEach((part) => {
      const index = part.indexOf("=");
      if (index === -1) return;
      jar[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    });
  return jar;
}

function sessionCookie(token, request, maxAgeSeconds) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return COOKIE_NAME + "=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAgeSeconds + secure;
}

function isSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (origin) return origin === new URL(request.url).origin;
  const site = request.headers.get("Sec-Fetch-Site");
  if (site) return site === "same-origin" || site === "none";
  return true;
}

/* ----------------------------------------------------------
   Schema
   ---------------------------------------------------------- */

async function ensureSchema(db) {
  if (schemaReady) return;

  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      sub TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      avatar_ver INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS credentials (
      user_sub TEXT PRIMARY KEY,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      iterations INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_sub TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS auth_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_sub TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS server_members (
      server_id TEXT NOT NULL,
      user_sub TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (server_id, user_sub)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS friends (
      requester TEXT NOT NULL,
      addressee TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (requester, addressee)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS forum_posts (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      author_sub TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS forum_replies (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_sub TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS voice_members (
      channel_id TEXT NOT NULL,
      user_sub TEXT NOT NULL,
      muted INTEGER NOT NULL DEFAULT 0,
      sharing INTEGER NOT NULL DEFAULT 0,
      joined_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (channel_id, user_sub)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS voice_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      from_sub TEXT NOT NULL,
      to_sub TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY,
      owner_sub TEXT NOT NULL,
      name TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '',
      permissions INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS member_roles (
      server_id TEXT NOT NULL,
      user_sub TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (server_id, user_sub, role_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      author_sub TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS messages_channel_time ON messages (channel, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS friends_addressee ON friends (addressee, status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_sub)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS attempts_ip ON auth_attempts (ip, at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS server_members_user ON server_members (user_sub)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS channels_server ON channels (server_id, position)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS forum_posts_channel ON forum_posts (channel_id, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS forum_replies_post ON forum_replies (post_id, created_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS voice_signals_to ON voice_signals (to_sub, id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS roles_server ON roles (server_id, position)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS member_roles_user ON member_roles (user_sub)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS member_roles_role ON member_roles (role_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS blocks (
      blocker TEXT NOT NULL,
      blocked TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (blocker, blocked)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
  ]);

  const columns = await db.prepare("PRAGMA table_info(users)").all();
  if (!columns.results.some((column) => column.name === "avatar_ver")) {
    await db.prepare("ALTER TABLE users ADD COLUMN avatar_ver INTEGER NOT NULL DEFAULT 0").run();
  }

  // Older servers only knew text channels; add the type and rules body.
  const channelColumns = await db.prepare("PRAGMA table_info(channels)").all();
  if (!channelColumns.results.some((column) => column.name === "type")) {
    await db.prepare("ALTER TABLE channels ADD COLUMN type TEXT NOT NULL DEFAULT 'text'").run();
  }
  if (!channelColumns.results.some((column) => column.name === "rules")) {
    await db.prepare("ALTER TABLE channels ADD COLUMN rules TEXT NOT NULL DEFAULT ''").run();
  }
  if (!channelColumns.results.some((column) => column.name === "is_logs")) {
    await db.prepare("ALTER TABLE channels ADD COLUMN is_logs INTEGER NOT NULL DEFAULT 0").run();
  }
  if (!channelColumns.results.some((column) => column.name === "category")) {
    await db.prepare("ALTER TABLE channels ADD COLUMN category TEXT NOT NULL DEFAULT ''").run();
  }

  if (!columns.results.some((column) => column.name === "banner_ver")) {
    await db.prepare("ALTER TABLE users ADD COLUMN banner_ver INTEGER NOT NULL DEFAULT 0").run();
  }

  const messageColumns = await db.prepare("PRAGMA table_info(messages)").all();
  if (!messageColumns.results.some((column) => column.name === "files")) {
    await db.prepare("ALTER TABLE messages ADD COLUMN files TEXT NOT NULL DEFAULT ''").run();
  }
  if (!messageColumns.results.some((column) => column.name === "kind")) {
    await db.prepare("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'").run();
  }
  if (!messageColumns.results.some((column) => column.name === "embeds")) {
    await db.prepare("ALTER TABLE messages ADD COLUMN embeds TEXT NOT NULL DEFAULT ''").run();
  }

  // Every server gets an activity log channel; older servers get one now.
  const missingLogs = await db
    .prepare(
      `SELECT s.id FROM servers s
        WHERE NOT EXISTS (SELECT 1 FROM channels c WHERE c.server_id = s.id AND c.is_logs = 1)`
    )
    .all();
  if (missingLogs.results.length) {
    await db.batch(
      missingLogs.results.map((row) =>
        db
          .prepare(
            "INSERT INTO channels (id, server_id, name, topic, position, type, rules, is_logs, created_at) VALUES (?, ?, 'logs', 'Server activity. Newest at the bottom.', 90, 'text', '', 1, ?)"
          )
          .bind(crypto.randomUUID(), row.id, Date.now())
      )
    );
  }

  const userExtras = {
    bio: "TEXT NOT NULL DEFAULT ''",
    pronouns: "TEXT NOT NULL DEFAULT ''",
    decor_json: "TEXT NOT NULL DEFAULT ''",
    decor_ver: "INTEGER NOT NULL DEFAULT 0",
    socials_json: "TEXT NOT NULL DEFAULT ''",
    status_text: "TEXT NOT NULL DEFAULT ''",
    status_expires: "INTEGER NOT NULL DEFAULT 0",
    presence: "TEXT NOT NULL DEFAULT 'online'",
    soundcloud_url: "TEXT NOT NULL DEFAULT ''",
    soundcloud_json: "TEXT NOT NULL DEFAULT ''",
    profile_css: "TEXT NOT NULL DEFAULT ''",
    profile_html: "TEXT NOT NULL DEFAULT ''",
  };
  const knownUserColumns = columns.results.map((column) => column.name);
  for (const [name, type] of Object.entries(userExtras)) {
    if (!knownUserColumns.includes(name)) {
      await db.prepare(`ALTER TABLE users ADD COLUMN ${name} ${type}`).run();
    }
  }

  const serverColumns = await db.prepare("PRAGMA table_info(servers)").all();
  if (!serverColumns.results.some((column) => column.name === "custom_code")) {
    await db.prepare("ALTER TABLE servers ADD COLUMN custom_code TEXT").run();
  }
  if (!serverColumns.results.some((column) => column.name === "icon_ver")) {
    await db.prepare("ALTER TABLE servers ADD COLUMN icon_ver INTEGER NOT NULL DEFAULT 0").run();
  }

  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS servers_custom_code ON servers (custom_code)").run();

  const userCols = await db.prepare("PRAGMA table_info(users)").all();
  for (const [name, type] of [
    ["name_font", "TEXT NOT NULL DEFAULT ''"],
    ["name_color1", "TEXT NOT NULL DEFAULT ''"],
    ["name_color2", "TEXT NOT NULL DEFAULT ''"],
    ["name_glow", "TEXT NOT NULL DEFAULT ''"],
  ]) {
    if (!userCols.results.some((column) => column.name === name)) {
      await db.prepare(`ALTER TABLE users ADD COLUMN ${name} ${type}`).run();
    }
  }

  if (!userCols.results.some((column) => column.name === "verified")) {
    await db.prepare("ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0").run();
  }
  await db
    .prepare("UPDATE users SET verified = 1 WHERE lower(handle) IN ('fleek', 'sc0pes') OR lower(display_name) IN ('fleek', 'sc0pes') OR sub = ?")
    .bind(OFFICIAL_BOT_SUB)
    .run();

  await ensureOfficialServer(db);

  schemaReady = true;
}

/* ----------------------------------------------------------
   Sessions
   ---------------------------------------------------------- */

async function currentUser(db, request) {
  const jar = parseCookies(request.headers.get("Cookie"));
  const token = jar[COOKIE_NAME];
  if (!token || token.length < 20) return null;

  const tokenHash = await sha256Hex(token);
  const now = Date.now();

  const row = await db
    .prepare(
      `SELECT u.sub, u.handle, u.display_name, u.avatar_ver, u.banner_ver,
              u.status_text, u.status_expires, u.presence,
              u.bio, u.pronouns, u.decor_json, u.decor_ver, u.socials_json,
              u.soundcloud_url, u.profile_css, u.profile_html, s.expires_at
         FROM sessions s JOIN users u ON u.sub = s.user_sub
        WHERE s.token_hash = ?`
    )
    .bind(tokenHash)
    .first();

  if (!row) return null;
  if (row.expires_at < now) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }

  return { ...row, tokenHash };
}

async function touchUser(db, sub, now) {
  await db
    .prepare("UPDATE users SET last_seen = ? WHERE sub = ? AND last_seen < ?")
    .bind(now, sub, now - TOUCH_MS)
    .run();
}

async function createSession(db, sub) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();

  await db
    .prepare(
      "INSERT INTO sessions (token_hash, user_sub, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(tokenHash, sub, now, now + SESSION_MS, now)
    .run();

  return token;
}

/* ----------------------------------------------------------
   Helpers
   ---------------------------------------------------------- */

function avatarUrl(sub, version) {
  return version ? "/api/avatar/" + encodeURIComponent(sub) + "?v=" + version : null;
}

function bannerUrl(sub, version) {
  return version ? "/api/banner/" + encodeURIComponent(sub) + "?v=" + version : null;
}

function serverIconUrl(id, version) {
  return version ? "/api/server-icon/" + encodeURIComponent(id) + "?v=" + version : null;
}

function decorUrl(sub, version) {
  return version ? "/api/decor/" + encodeURIComponent(sub) + "?v=" + version : null;
}

const DECOR_KINDS = new Set(["none", "glow", "horns", "wings", "custom"]);

function shapeDecor(row) {
  let decor = null;
  try {
    decor = JSON.parse(row.decor_json || "null");
  } catch {
    decor = null;
  }
  if (!decor || !DECOR_KINDS.has(decor.kind) || decor.kind === "none") return null;

  return {
    kind: decor.kind,
    color: /^#[0-9a-f]{6}$/i.test(String(decor.color || "")) ? String(decor.color).toLowerCase() : "#5865f2",
    color2: /^#[0-9a-f]{6}$/i.test(String(decor.color2 || "")) ? String(decor.color2).toLowerCase() : "#ffffff",
    animated: !!decor.animated,
    url: decor.kind === "custom" ? decorUrl(row.sub, row.decor_ver) : null,
  };
}

const SOCIAL_KEYS = ["reddit", "roblox", "discord", "telegram", "tiktok"];

function shapeSocials(row) {
  let raw = {};
  try {
    raw = JSON.parse(row.socials_json || "{}");
  } catch {
    raw = {};
  }
  if (!raw || typeof raw !== "object") return {};

  const out = {};
  SOCIAL_KEYS.forEach((key) => {
    const value = String(raw[key] || "").trim().replace(/^@/, "").slice(0, 60);
    if (/^[A-Za-z0-9._-]{1,60}$/.test(value)) out[key] = value;
  });

  const site = String(raw.website || "").trim().slice(0, 300);
  if (site) {
    try {
      const parsed = new URL(site);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") out.website = parsed.toString();
    } catch {
      /* not a link */
    }
  }

  return out;
}

function parseEmbeds(raw) {
  try {
    const list = JSON.parse(raw || "[]");
    return Array.isArray(list) ? list.slice(0, 4) : [];
  } catch {
    return [];
  }
}

const OFFICIAL_WELCOME =
  "Welcome to **Fleeks**, the official Fleek server.\n\n" +
  "Start with <#rules>, say hi in <#introductions>, and use <#help> if something breaks. " +
  "Everything here is free: no Nitro, no paywalls.";

async function ensureOfficialServer(db) {
  const now = Date.now();

  await db
    .prepare(
      `INSERT OR IGNORE INTO users (sub, handle, display_name, avatar_ver, created_at, last_seen, bio, pronouns)
       VALUES (?, 'fleekbot', 'Fleek', 1, ?, ?, 'Official Fleek helper. Posts the rules, announcements and logs.', 'it/its')`
    )
    .bind(OFFICIAL_BOT_SUB, now, now)
    .run();

  const existing = await db.prepare("SELECT id, icon_ver FROM servers WHERE id = ?").bind(OFFICIAL_SERVER_ID).first();

  if (!existing) {
    let code = "fleeks";
    const taken = await db
      .prepare("SELECT 1 AS ok FROM servers WHERE invite_code = ? OR custom_code = ?")
      .bind(code, code)
      .first();
    if (taken) code = "fleeks-hq";

    await db
      .prepare(
        "INSERT OR IGNORE INTO servers (id, name, owner_sub, invite_code, custom_code, icon_ver, created_at) VALUES (?, 'Fleeks', ?, ?, ?, 1, ?)"
      )
      .bind(OFFICIAL_SERVER_ID, OFFICIAL_BOT_SUB, code, code, now)
      .run();
  } else if (!existing.icon_ver) {
    await db.prepare("UPDATE servers SET icon_ver = 1 WHERE id = ?").bind(OFFICIAL_SERVER_ID).run();
  }

  const everyone = await db
    .prepare("SELECT id FROM roles WHERE server_id = ? AND name = '@everyone'")
    .bind(OFFICIAL_SERVER_ID)
    .first();

  if (!everyone) {
    await db
      .prepare(
        "INSERT INTO roles (id, server_id, name, color, permissions, position, created_at) VALUES (?, ?, '@everyone', '', 0, 0, ?)"
      )
      .bind(crypto.randomUUID(), OFFICIAL_SERVER_ID, now)
      .run();
  }

  let position = 0;
  for (const starter of OFFICIAL_CHANNELS) {
    const channel = await db
      .prepare("SELECT id, rules FROM channels WHERE server_id = ? AND name = ?")
      .bind(OFFICIAL_SERVER_ID, starter.name)
      .first();

    if (!channel) {
      await db
        .prepare(
          "INSERT INTO channels (id, server_id, name, topic, position, type, rules, is_logs, category, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(
          crypto.randomUUID(),
          OFFICIAL_SERVER_ID,
          starter.name,
          starter.topic,
          position,
          starter.type,
          starter.type === "rules" ? OFFICIAL_RULES : "",
          starter.logs ? 1 : 0,
          starter.category,
          now
        )
        .run();
    } else if (starter.type === "rules" && !channel.rules) {
      await db.prepare("UPDATE channels SET rules = ? WHERE id = ?").bind(OFFICIAL_RULES, channel.id).run();
    }

    position += 1;
  }

  const welcome = await db
    .prepare("SELECT id FROM channels WHERE server_id = ? AND name = 'welcome'")
    .bind(OFFICIAL_SERVER_ID)
    .first();

  if (welcome) {
    const posted = await db.prepare("SELECT 1 AS ok FROM messages WHERE channel = ? LIMIT 1").bind(welcome.id).first();
    if (!posted) {
      await db
        .prepare(
          "INSERT INTO messages (id, channel, author_sub, body, created_at, files, kind, embeds) VALUES (?, ?, ?, ?, ?, '', 'user', '')"
        )
        .bind(crypto.randomUUID(), welcome.id, OFFICIAL_BOT_SUB, OFFICIAL_WELCOME, now)
        .run();
    }
  }

  const announcements = await db
    .prepare("SELECT id FROM channels WHERE server_id = ? AND name = 'announcements'")
    .bind(OFFICIAL_SERVER_ID)
    .first();

  if (announcements) {
    const posted = await db.prepare("SELECT 1 AS ok FROM messages WHERE channel = ? LIMIT 1").bind(announcements.id).first();
    if (!posted) {
      await db
        .prepare(
          "INSERT INTO messages (id, channel, author_sub, body, created_at, files, kind, embeds) VALUES (?, ?, ?, ?, ?, '', 'user', ?)"
        )
        .bind(
          crypto.randomUUID(),
          announcements.id,
          OFFICIAL_BOT_SUB,
          "Fleeks is open. Say hi in #introductions and read #rules first.",
          now,
          JSON.stringify([
            {
              title: "Welcome to Fleeks",
              description: "This is the official Fleek community server. Free voice, forums, roles and themes for everyone.",
              color: 0x5865f2,
            },
          ])
        )
        .run();
    }
  }

  await db
    .prepare("INSERT OR IGNORE INTO server_members (server_id, user_sub, joined_at) SELECT ?, sub, ? FROM users")
    .bind(OFFICIAL_SERVER_ID, now)
    .run();
}

async function logEvent(db, serverId, actor, title, description) {
  const channel = await db
    .prepare("SELECT id FROM channels WHERE server_id = ? AND is_logs = 1 LIMIT 1")
    .bind(serverId)
    .first();
  if (!channel || !actor) return;

  const embed = JSON.stringify([
    {
      title: String(title).slice(0, 120),
      description: String(description || "").slice(0, 600),
      color: 0x5865f2,
    },
  ]);

  await db
    .prepare(
      "INSERT INTO messages (id, channel, author_sub, body, created_at, files, kind, embeds) VALUES (?, ?, ?, '', ?, '', 'log', ?)"
    )
    .bind(crypto.randomUUID(), channel.id, actor, Date.now(), embed)
    .run();
}

function fileUrl(id) {
  return "/api/files/" + id;
}

function shapeUpload(row) {
  return { id: row.id, name: row.name, mime: row.mime, size: row.size, url: fileUrl(row.id) };
}

function looksLikeImage(bytes) {
  if (bytes.length < 12) return false;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return true;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return true;
  }
  return false;
}

function dmChannel(a, b) {
  return "dm:" + [a, b].sort().join("|");
}

async function friendSubs(db, sub) {
  const res = await db
    .prepare(
      `SELECT u.sub FROM friends f
         JOIN users u ON u.sub = CASE WHEN f.requester = ? THEN f.addressee ELSE f.requester END
        WHERE (f.requester = ? OR f.addressee = ?) AND f.status = 'accepted'`
    )
    .bind(sub, sub, sub)
    .all();
  return res.results.map((row) => row.sub);
}

async function canAccessChannel(db, channel, sub) {
  if (channel.startsWith("dm:")) {
    const parts = channel.slice(3).split("|");
    if (parts.length !== 2 || !parts.includes(sub)) return false;
    const other = parts.find((part) => part !== sub);
    const friends = await friendSubs(db, sub);
    return friends.includes(other);
  }

  const row = await db
    .prepare(
      `SELECT c.id FROM channels c
         JOIN server_members m ON m.server_id = c.server_id
        WHERE c.id = ? AND m.user_sub = ?`
    )
    .bind(channel, sub)
    .first();

  return !!row;
}

async function isServerMember(db, serverId, sub) {
  const row = await db
    .prepare("SELECT 1 AS ok FROM server_members WHERE server_id = ? AND user_sub = ?")
    .bind(serverId, sub)
    .first();
  return !!row;
}

function shapeMessage(row) {
  return {
    id: row.id,
    channel: row.channel,
    body: row.body,
    createdAt: row.created_at,
    author: {
      sub: row.author_sub,
      handle: row.handle,
      displayName: row.display_name,
      avatarUrl: avatarUrl(row.author_sub, row.avatar_ver),
      verified: !!row.verified || row.sub === OFFICIAL_BOT_SUB || ["sc0pes", "fleek"].includes(String(row.handle || "").toLowerCase()) || ["sc0pes", "fleek"].includes(String(row.display_name || "").toLowerCase()),
      nameFont: row.name_font || "",
      nameColor1: row.name_color1 || "",
      nameColor2: row.name_color2 || "",
      nameGlow: row.name_glow || "",
    },
  };
}

async function tooManyAttempts(db, ip) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ? AND at > ?")
    .bind(ip, Date.now() - ATTEMPT_WINDOW_MS)
    .first();
  return !!row && row.n >= MAX_ATTEMPTS;
}

async function noteAttempt(db, ip) {
  await db.prepare("INSERT INTO auth_attempts (ip, at) VALUES (?, ?)").bind(ip, Date.now()).run();
  await db
    .prepare("DELETE FROM auth_attempts WHERE at < ?")
    .bind(Date.now() - ATTEMPT_WINDOW_MS * 4)
    .run();
}

function shapeMember(row, now) {
  return {
    sub: row.sub,
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: avatarUrl(row.sub, row.avatar_ver),
    bannerUrl: row.banner_ver ? bannerUrl(row.sub, row.banner_ver) : null,
    statusText: row.status_expires && row.status_expires < now ? "" : row.status_text || "",
    statusUntil: row.status_expires || 0,
    presence: row.presence || "online",
    online: (row.presence || "online") !== "offline" && now - row.last_seen < ONLINE_MS,
    bio: row.bio || "",
    pronouns: row.pronouns || "",
    decor: shapeDecor(row),
    socials: shapeSocials(row),
    nameFont: row.name_font || "",
    nameColor1: row.name_color1 || "",
    nameColor2: row.name_color2 || "",
    nameGlow: row.name_glow || "",
    verified: !!row.verified || row.sub === OFFICIAL_BOT_SUB || ["sc0pes", "fleek"].includes(String(row.handle || "").toLowerCase()) || ["sc0pes", "fleek"].includes(String(row.display_name || "").toLowerCase()),
  };
}

/* Owner or a role whose bitmask includes every requested bit. */
async function canManage(db, serverId, sub, perm) {
  if (!serverId) return false;

  const server = await db.prepare("SELECT owner_sub FROM servers WHERE id = ?").bind(serverId).first();
  if (!server) return false;
  if (server.owner_sub === sub) return true;

  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(r.permissions), 0) AS bits
         FROM member_roles mr JOIN roles r ON r.id = mr.role_id
        WHERE mr.server_id = ? AND mr.user_sub = ?`
    )
    .bind(serverId, sub)
    .first();

  const bits = row ? Number(row.bits) || 0 : 0;
  return (bits & perm) === perm;
}

/* ----------------------------------------------------------
   API
   ---------------------------------------------------------- */

async function handleApi(request, env) {
  const url = new URL(request.url);
  const db = env.DB;

  if (!db) return fail("Database is not configured yet.", 500);
  await ensureSchema(db);

  const method = request.method;

  if (method !== "GET" && !isSameOrigin(request)) {
    return fail("Cross-origin request blocked.", 403);
  }

  /* ---------------- accounts ---------------- */

  if (url.pathname === "/api/auth/signup" && method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    if (await tooManyAttempts(db, ip)) return fail("Too many attempts. Try again later.", 429);

    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const handle = String(body.handle || "").trim().toLowerCase();
    const password = String(body.password || "");
    const displayName = String(body.displayName || "").trim().slice(0, 32) || handle;

    if (!HANDLE_RE.test(handle)) return fail("Handles are 2–24 characters: letters, numbers and underscores.");
    if (RESERVED.has(handle)) return fail("That handle is reserved.");
    if (password.length < 8) return fail("Passwords need at least 8 characters.");
    if (password.length > 200) return fail("That password is too long.");

    const now = Date.now();
    const sub = crypto.randomUUID();
    const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await hashPassword(password, base64ToBytes(salt), PBKDF2_ITERATIONS);

    try {
      await db.batch([
        db
          .prepare("INSERT INTO users (sub, handle, display_name, avatar_ver, created_at, last_seen) VALUES (?, ?, ?, 0, ?, ?)")
          .bind(sub, handle, displayName, now, now),
        db
          .prepare("INSERT INTO credentials (user_sub, salt, hash, iterations, created_at) VALUES (?, ?, ?, ?, ?)")
          .bind(sub, salt, hash, PBKDF2_ITERATIONS, now),
        db
          .prepare("INSERT OR IGNORE INTO server_members (server_id, user_sub, joined_at) VALUES (?, ?, ?)")
          .bind(OFFICIAL_SERVER_ID, sub, now),
      ]);
    } catch (error) {
      if (String(error && error.message).includes("UNIQUE")) return fail("That handle is already taken.", 409);
      throw error;
    }

    await noteAttempt(db, ip);
    const token = await createSession(db, sub);

    return json(
      { ok: true, profile: { handle, displayName, avatarUrl: null } },
      200,
      { "set-cookie": sessionCookie(token, request, SESSION_MS / 1000) }
    );
  }

  if (url.pathname === "/api/auth/login" && method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "local";
    if (await tooManyAttempts(db, ip)) return fail("Too many attempts. Try again later.", 429);

    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const handle = String(body.handle || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!handle || !password) return fail("Enter your handle and password.");

    const row = await db
      .prepare(
        `SELECT u.sub, u.handle, u.display_name, u.avatar_ver, u.banner_ver, c.salt, c.hash, c.iterations
           FROM users u JOIN credentials c ON c.user_sub = u.sub
          WHERE u.handle = ?`
      )
      .bind(handle)
      .first();

    await noteAttempt(db, ip);
    if (!row) return fail("Wrong handle or password.", 401);

    const candidate = await hashPassword(password, base64ToBytes(row.salt), row.iterations);
    if (!constantTimeEqual(candidate, row.hash)) return fail("Wrong handle or password.", 401);

    const token = await createSession(db, row.sub);
    return json(
      {
        ok: true,
        profile: {
          handle: row.handle,
          displayName: row.display_name,
          avatarUrl: avatarUrl(row.sub, row.avatar_ver),
          bannerUrl: bannerUrl(row.sub, row.banner_ver),
        },
      },
      200,
      { "set-cookie": sessionCookie(token, request, SESSION_MS / 1000) }
    );
  }

  if (url.pathname === "/api/auth/logout" && method === "POST") {
    const user = await currentUser(db, request);
    if (user) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.tokenHash).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", request, 0) });
  }

  if (url.pathname === "/api/session" && method === "GET") {
    const user = await currentUser(db, request);
    if (!user) return fail("Sign in required.", 401);
    await touchUser(db, user.sub, Date.now());

    return json({
      user: { sub: user.sub, name: user.display_name },
      profile: {
        handle: user.handle,
        displayName: user.display_name,
        avatarUrl: avatarUrl(user.sub, user.avatar_ver),
        bannerUrl: bannerUrl(user.sub, user.banner_ver),
      },
      needsHandle: false,
    });
  }

  const webhookPost = /^\/api\/webhooks\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (webhookPost && method === "POST") {
    const hook = await db
      .prepare(
        `SELECT w.id, w.name, w.channel_id, w.token, s.owner_sub, s.id AS server_id
           FROM webhooks w JOIN servers s ON s.id = w.server_id WHERE w.id = ?`
      )
      .bind(decodeURIComponent(webhookPost[1]))
      .first();

    if (!hook || hook.token !== decodeURIComponent(webhookPost[2])) return fail("Unknown webhook.", 404);

    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Send JSON: { content, embeds }.");
    }

    const content = String(body.content || "").trim().slice(0, 2000);
    const embeds = Array.isArray(body.embeds)
      ? body.embeds.slice(0, 4).map((embed) => ({
          title: String((embed && embed.title) || "").slice(0, 120),
          description: String((embed && embed.description) || "").slice(0, 600),
          color: Math.max(0, Math.min(Number((embed && embed.color) || 0) || 0x5865f2, 0xffffff)),
        }))
      : [];

    if (!content && !embeds.length) return fail("Send something in content or embeds.");

    const id = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO messages (id, channel, author_sub, body, created_at, files, kind, embeds) VALUES (?, ?, ?, ?, ?, '', 'webhook', ?)"
      )
      .bind(id, hook.channel_id, hook.owner_sub, content, Date.now(), JSON.stringify(embeds))
      .run();

    await logEvent(db, hook.server_id, hook.owner_sub, "Webhook posted", (hook.name || "Webhook") + " sent a message.");

    return json({ ok: true, id });
  }

  const me = await currentUser(db, request);
  if (!me) return fail("Sign in required.", 401);

  const now = Date.now();
  await touchUser(db, me.sub, now);

  /* ---------------- decor + blocks ---------------- */

  if (url.pathname.startsWith("/api/decor/") && method === "GET") {
    if (!env.FILES) return fail("Image storage is not configured yet.", 500);
    const sub = decodeURIComponent(url.pathname.slice("/api/decor/".length));
    const object = await env.FILES.get("decor/" + sub);
    if (!object) return new Response(null, { status: 404 });
    return new Response(object.body, {
      headers: {
        "content-type": (object.httpMetadata && object.httpMetadata.contentType) || "image/png",
        "cache-control": "public, max-age=31536000, immutable",
        etag: object.httpEtag,
      },
    });
  }

  if (url.pathname === "/api/decor" && (method === "POST" || method === "DELETE")) {
    if (!env.FILES) return fail("Image storage is not configured yet.", 500);

    if (method === "DELETE") {
      await env.FILES.delete("decor/" + me.sub);
      await db.prepare("UPDATE users SET decor_ver = decor_ver + 1 WHERE sub = ?").bind(me.sub).run();
      return json({ ok: true, decorUrl: null });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ""));
    if (!match) return fail("Upload a PNG, JPEG, WebP or GIF image.");
    if (match[2].length > 800000) return fail("That image is too large (600 KB max).", 413);

    const bytes = base64ToBytes(match[2]);
    if (!looksLikeImage(bytes)) return fail("That file isn't a valid image.");

    await env.FILES.put("decor/" + me.sub, bytes, {
      httpMetadata: { contentType: match[1], cacheControl: "public, max-age=31536000, immutable" },
    });
    await db.prepare("UPDATE users SET decor_ver = decor_ver + 1 WHERE sub = ?").bind(me.sub).run();

    const fresh = await db.prepare("SELECT decor_ver FROM users WHERE sub = ?").bind(me.sub).first();
    return json({ ok: true, decorUrl: decorUrl(me.sub, fresh ? fresh.decor_ver : 1) });
  }

  if (url.pathname === "/api/block" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const target = String(body.sub || "");
    if (!target || target === me.sub) return fail("Pick someone else.");

    if (body.action === "unblock") {
      await db.prepare("DELETE FROM blocks WHERE blocker = ? AND blocked = ?").bind(me.sub, target).run();
      return json({ ok: true, blocked: false });
    }

    await db
      .prepare("INSERT OR IGNORE INTO blocks (blocker, blocked, created_at) VALUES (?, ?, ?)")
      .bind(me.sub, target, now)
      .run();

    await db
      .prepare("DELETE FROM friends WHERE (requester = ? AND addressee = ?) OR (requester = ? AND addressee = ?)")
      .bind(me.sub, target, target, me.sub)
      .run();

    return json({ ok: true, blocked: true });
  }

  /* ---------------- profile ---------------- */

  if (url.pathname === "/api/profile" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const updates = [];
    const values = [];

    if (Object.prototype.hasOwnProperty.call(body, "displayName")) {
      const displayName = String(body.displayName || "").trim().slice(0, 32);
      if (!displayName) return fail("Display name can't be empty.");
      updates.push("display_name = ?");
      values.push(displayName);
    }

    if (Object.prototype.hasOwnProperty.call(body, "soundcloud")) {
      const raw = String(body.soundcloud || "").trim().slice(0, 300);

      if (!raw) {
        updates.push("soundcloud_url = ?", "soundcloud_json = ?");
        values.push("", "");
      } else {
        let parsed;
        try {
          parsed = new URL(raw);
        } catch {
          return fail("Paste a SoundCloud track link.");
        }
        if (parsed.protocol !== "https:" || !/(^|\.)soundcloud\.com$/i.test(parsed.hostname)) {
          return fail("Paste a SoundCloud track link (https://soundcloud.com/...).");
        }

        let meta = "";
        try {
          const res = await fetch(
            "https://soundcloud.com/oembed?format=json&url=" + encodeURIComponent(parsed.toString())
          );
          if (res.ok) {
            const data = await res.json();
            meta = JSON.stringify({
              title: String(data.title || "SoundCloud").slice(0, 120),
              author: String(data.author_name || "").slice(0, 80),
              art: String(data.thumbnail_url || "").slice(0, 400),
            });
          }
        } catch {
          meta = "";
        }

        updates.push("soundcloud_url = ?", "soundcloud_json = ?");
        values.push(parsed.toString(), meta);
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "profileCss")) {
      updates.push("profile_css = ?");
      values.push(String(body.profileCss || "").slice(0, PROFILE_TEXT_MAX));
    }

    if (Object.prototype.hasOwnProperty.call(body, "profileHtml")) {
      updates.push("profile_html = ?");
      values.push(String(body.profileHtml || "").slice(0, PROFILE_TEXT_MAX));
    }

    if (Object.prototype.hasOwnProperty.call(body, "bio")) {
      updates.push("bio = ?");
      values.push(String(body.bio || "").replace(/\r\n/g, "\n").slice(0, 300));
    }

    if (Object.prototype.hasOwnProperty.call(body, "pronouns")) {
      updates.push("pronouns = ?");
      values.push(String(body.pronouns || "").trim().slice(0, 24));
    }

    if (Object.prototype.hasOwnProperty.call(body, "socials")) {
      const incoming = body.socials && typeof body.socials === "object" ? body.socials : {};
      const clean = {};

      SOCIAL_KEYS.forEach((key) => {
        const value = String(incoming[key] || "").trim().replace(/^@/, "").slice(0, 60);
        if (/^[A-Za-z0-9._-]{1,60}$/.test(value)) clean[key] = value;
      });

      const site = String(incoming.website || "").trim().slice(0, 300);
      if (site) {
        try {
          const parsed = new URL(site);
          if (parsed.protocol === "https:" || parsed.protocol === "http:") clean.website = parsed.toString();
        } catch {
          return fail("Your website needs to be a full link, like https://example.com.");
        }
      }

      updates.push("socials_json = ?");
      values.push(JSON.stringify(clean));
    }

    if (Object.prototype.hasOwnProperty.call(body, "decor")) {
      const raw = body.decor;
      if (!raw || raw.kind === "none" || !DECOR_KINDS.has(String(raw.kind))) {
        updates.push("decor_json = ?");
        values.push("");
      } else {
        const decor = {
          kind: String(raw.kind),
          color: /^#[0-9a-f]{6}$/i.test(String(raw.color || "")) ? String(raw.color).toLowerCase() : "#5865f2",
          color2: /^#[0-9a-f]{6}$/i.test(String(raw.color2 || "")) ? String(raw.color2).toLowerCase() : "#ffffff",
          animated: !!raw.animated,
        };
        updates.push("decor_json = ?");
        values.push(JSON.stringify(decor));
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "nameFont")) {
      const font = String(body.nameFont || "");
      if (!NAME_FONTS.has(font)) return fail("Unknown name font.");
      updates.push("name_font = ?");
      values.push(font);
    }

    if (Object.prototype.hasOwnProperty.call(body, "nameColor1")) {
      const color = String(body.nameColor1 || "");
      if (color && !/^#[0-9a-f]{6}$/i.test(color)) return fail("Pick a valid name colour.");
      updates.push("name_color1 = ?");
      values.push(color.toLowerCase());
    }

    if (Object.prototype.hasOwnProperty.call(body, "nameColor2")) {
      const color = String(body.nameColor2 || "");
      if (color && !/^#[0-9a-f]{6}$/i.test(color)) return fail("Pick a valid name colour.");
      updates.push("name_color2 = ?");
      values.push(color.toLowerCase());
    }

    if (Object.prototype.hasOwnProperty.call(body, "nameGlow")) {
      const glow = String(body.nameGlow || "");
      if (glow && !/^#[0-9a-f]{6}$/i.test(glow)) return fail("Pick a valid glow colour.");
      updates.push("name_glow = ?");
      values.push(glow.toLowerCase());
    }

    if (!updates.length) return fail("Nothing to change.");

    values.push(me.sub);
    await db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE sub = ?`).bind(...values).run();

    return json({ ok: true });
  }

  if (url.pathname.startsWith("/api/avatar/") && method === "GET") {
    if (!env.FILES) return fail("Image storage is not configured yet.", 500);

    const sub = decodeURIComponent(url.pathname.slice("/api/avatar/".length));
    if (!sub || sub.length > 80) return fail("Unknown avatar.", 404);

    if (sub === OFFICIAL_BOT_SUB) {
      const asset = await env.ASSETS.fetch(new URL("/assets/fleek.png", url).toString());
      if (asset.ok) {
        return new Response(asset.body, {
          headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
        });
      }
    }

    const object = await env.FILES.get("avatars/" + sub);
    if (!object) return new Response(null, { status: 404 });

    return new Response(object.body, {
      headers: {
        "content-type": (object.httpMetadata && object.httpMetadata.contentType) || "image/webp",
        "cache-control": "public, max-age=31536000, immutable",
        etag: object.httpEtag,
      },
    });
  }

  if (url.pathname === "/api/avatar" && (method === "POST" || method === "DELETE")) {
    if (!env.FILES) return fail("Image storage is not configured yet.", 500);

    if (method === "DELETE") {
      await env.FILES.delete("avatars/" + me.sub);
      await db.prepare("UPDATE users SET avatar_ver = avatar_ver + 1 WHERE sub = ?").bind(me.sub).run();
      return json({ ok: true, avatarUrl: null });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ""));
    if (!match) return fail("Upload a PNG, JPEG, WebP or GIF image.");
    if (match[2].length > 1600000) return fail("That image is too large. Try a smaller one.", 413);

    const bytes = base64ToBytes(match[2]);
    if (!looksLikeImage(bytes)) return fail("That file isn't a valid image.");
    if (bytes.byteLength > 1200000) return fail("That image is too large. Try a smaller one.", 413);

    await env.FILES.put("avatars/" + me.sub, bytes, {
      httpMetadata: { contentType: match[1], cacheControl: "public, max-age=31536000, immutable" },
    });
    await db.prepare("UPDATE users SET avatar_ver = avatar_ver + 1 WHERE sub = ?").bind(me.sub).run();

    const fresh = await db.prepare("SELECT avatar_ver FROM users WHERE sub = ?").bind(me.sub).first();
    return json({ ok: true, avatarUrl: avatarUrl(me.sub, fresh ? fresh.avatar_ver : 1) });
  }

  /* ---------------- servers ---------------- */

  if (url.pathname === "/api/servers" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (name.length < 2) return fail("Give your server a name (2–40 characters).");

    const serverId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const code = inviteCode();

    // A new server starts with the channel types people expect: somewhere to
    // talk, somewhere to announce, the rules, a forum and a voice room.
    const starters = [
      { name: "general", type: "text", topic: "Say hi and share what you're building." },
      { name: "announcements", type: "announcement", topic: "Owner posts only. Everyone reads." },
      { name: "rules", type: "rules", topic: "Read before you post." },
      { name: "forum", type: "forum", topic: "Longer thoughts, one post at a time." },
      { name: "General", type: "voice", topic: "Hop in and talk." },
      { name: "logs", type: "text", topic: "Server activity: joins, deletions, roles and webhooks.", logs: true },
    ];

    await db.batch([
      db
        .prepare("INSERT INTO servers (id, name, owner_sub, invite_code, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(serverId, name, me.sub, code, now),
      db
        .prepare("INSERT INTO server_members (server_id, user_sub, joined_at) VALUES (?, ?, ?)")
        .bind(serverId, me.sub, now),
      db
        .prepare(
          "INSERT INTO roles (id, server_id, name, color, permissions, position, created_at) VALUES (?, ?, '@everyone', '', 0, 0, ?)"
        )
        .bind(crypto.randomUUID(), serverId, now),
      ...starters.map((starter, index) =>
        db
          .prepare(
            "INSERT INTO channels (id, server_id, name, topic, position, type, rules, is_logs, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(
            index === 0 ? channelId : crypto.randomUUID(),
            serverId,
            starter.name,
            starter.topic,
            index,
            starter.type,
            starter.type === "rules" ? STARTER_RULES : "",
            starter.logs ? 1 : 0,
            now
          )
      ),
    ]);

    return json({ ok: true, serverId, channelId, inviteCode: code });
  }

  if (url.pathname === "/api/servers/join" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const code = String(body.code || "").trim().toLowerCase();
    if (!code) return fail("Enter an invite code.");

    const server = await db
      .prepare("SELECT id, name FROM servers WHERE invite_code = ? OR custom_code = ?")
      .bind(code, code)
      .first();

    if (!server) return fail("That invite code doesn't match a server.", 404);

    const alreadyIn = await db
      .prepare("SELECT 1 AS ok FROM server_members WHERE server_id = ? AND user_sub = ?")
      .bind(server.id, me.sub)
      .first();

    await db
      .prepare("INSERT OR IGNORE INTO server_members (server_id, user_sub, joined_at) VALUES (?, ?, ?)")
      .bind(server.id, me.sub, now)
      .run();

    if (!alreadyIn) {
      await logEvent(db, server.id, me.sub, "Member joined", "@" + me.handle + " joined the server.");
    }

    return json({ ok: true, serverId: server.id, name: server.name });
  }

  const channelMatch = /^\/api\/servers\/([^/]+)\/channels$/.exec(url.pathname);
  if (channelMatch && method === "POST") {
    const serverId = decodeURIComponent(channelMatch[1]);
    if (!(await isServerMember(db, serverId, me.sub))) return fail("You're not in that server.", 403);
    if (!(await canManage(db, serverId, me.sub, PERM.MANAGE_CHANNELS))) {
      return fail("You need the Manage channels permission to do that.", 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const name = String(body.name || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 24);

    if (!CHANNEL_RE.test(name)) return fail("Channel names use lowercase letters, numbers and dashes.");

    const type = CHANNEL_TYPES.has(String(body.type || "text")) ? String(body.type || "text") : "text";

    const exists = await db
      .prepare("SELECT 1 AS ok FROM channels WHERE server_id = ? AND name = ?")
      .bind(serverId, name)
      .first();
    if (exists) return fail("That channel already exists.", 409);

    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM channels WHERE server_id = ?")
      .bind(serverId)
      .first();

    const id = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO channels (id, server_id, name, topic, position, type, rules, created_at) VALUES (?, ?, ?, '', ?, ?, '', ?)"
      )
      .bind(id, serverId, name, count ? count.n : 0, type, now)
      .run();

    await logEvent(db, serverId, me.sub, "Channel created", "#" + name + " (" + type + ")");

    return json({ ok: true, channel: { id, name, topic: "", type } });
  }

  const leaveMatch = /^\/api\/servers\/([^/]+)\/leave$/.exec(url.pathname);
  if (leaveMatch && method === "POST") {
    const serverId = decodeURIComponent(leaveMatch[1]);
    const server = await db.prepare("SELECT id, name, owner_sub FROM servers WHERE id = ?").bind(serverId).first();
    if (!server) return fail("That server no longer exists.", 404);
    if (server.owner_sub === me.sub) return fail("You own this server — delete it instead of leaving.");
    if (!(await isServerMember(db, serverId, me.sub))) return fail("You're not in that server.", 403);

    await db
      .prepare("DELETE FROM server_members WHERE server_id = ? AND user_sub = ?")
      .bind(serverId, me.sub)
      .run();

    return json({ ok: true });
  }

  const serverMatch = /^\/api\/servers\/([^/]+)$/.exec(url.pathname);
  if (serverMatch && method === "DELETE") {
    const serverId = decodeURIComponent(serverMatch[1]);
    const server = await db.prepare("SELECT id, owner_sub FROM servers WHERE id = ?").bind(serverId).first();
    if (!server) return fail("That server no longer exists.", 404);
    if (server.owner_sub !== me.sub) return fail("Only the owner can delete this server.", 403);

    await db.batch([
      db.prepare("DELETE FROM messages WHERE channel IN (SELECT id FROM channels WHERE server_id = ?)").bind(serverId),
      db
        .prepare(
          "DELETE FROM forum_replies WHERE post_id IN (SELECT id FROM forum_posts WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?))"
        )
        .bind(serverId),
      db
        .prepare("DELETE FROM forum_posts WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?)")
        .bind(serverId),
      db
        .prepare("DELETE FROM voice_members WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?)")
        .bind(serverId),
      db
        .prepare("DELETE FROM voice_signals WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?)")
        .bind(serverId),
      db.prepare("DELETE FROM channels WHERE server_id = ?").bind(serverId),
      db.prepare("DELETE FROM member_roles WHERE server_id = ?").bind(serverId),
      db.prepare("DELETE FROM roles WHERE server_id = ?").bind(serverId),
      db.prepare("DELETE FROM server_members WHERE server_id = ?").bind(serverId),
      db.prepare("DELETE FROM servers WHERE id = ?").bind(serverId),
    ]);

    return json({ ok: true });
  }

  const serverEditMatch = /^\/api\/servers\/([^/]+)$/.exec(url.pathname);
  if (serverEditMatch && method === "PATCH") {
    const serverId = decodeURIComponent(serverEditMatch[1]);
    if (!(await canManage(db, serverId, me.sub, PERM.MANAGE_CHANNELS))) {
      return fail("You need the Manage channels permission to edit this server.", 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (name.length < 2) return fail("Give your server a name (2–40 characters).");

    await db.prepare("UPDATE servers SET name = ? WHERE id = ?").bind(name, serverId).run();
    await logEvent(db, serverId, me.sub, "Server renamed", "Now called " + name + ".");

    return json({ ok: true, name });
  }

  if (url.pathname.startsWith("/api/server-icon/") && method === "GET") {
    if (!env.FILES) return fail("Image storage is not configured yet.", 500);
    const id = decodeURIComponent(url.pathname.slice("/api/server-icon/".length));

    if (id === OFFICIAL_SERVER_ID) {
      const asset = await env.ASSETS.fetch(new URL("/assets/fleek-black.png", url).toString());
      if (asset.ok) {
        return new Response(asset.body, {
          headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
        });
      }
    }

    const object = await env.FILES.get("server-icons/" + id);
    if (!object) return new Response(null, { status: 404 });
    return new Response(object.body, {
      headers: {
        "content-type": (object.httpMetadata && object.httpMetadata.contentType) || "image/png",
        "cache-control": "public, max-age=31536000, immutable",
        etag: object.httpEtag,
      },
    });
  }

  const serverIconMatch = /^\/api\/servers\/([^/]+)\/icon$/.exec(url.pathname);
  if (serverIconMatch && (method === "POST" || method === "DELETE")) {
    if (!env.FILES) return fail("Image storage is not configured yet.", 500);
    const serverId = decodeURIComponent(serverIconMatch[1]);
    if (!(await canManage(db, serverId, me.sub, PERM.MANAGE_CHANNELS))) {
      return fail("You need the Manage channels permission to change the icon.", 403);
    }

    if (method === "DELETE") {
      await env.FILES.delete("server-icons/" + serverId);
      await db.prepare("UPDATE servers SET icon_ver = icon_ver + 1 WHERE id = ?").bind(serverId).run();
      return json({ ok: true, iconUrl: null });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ""));
    if (!match) return fail("Upload a PNG, JPEG, WebP or GIF image.");
    if (match[2].length > 1400000) return fail("That image is too large. Try a smaller one.", 413);

    const bytes = base64ToBytes(match[2]);
    if (!looksLikeImage(bytes)) return fail("That file isn't a valid image.");

    await env.FILES.put("server-icons/" + serverId, bytes, {
      httpMetadata: { contentType: match[1], cacheControl: "public, max-age=31536000, immutable" },
    });
    await db.prepare("UPDATE servers SET icon_ver = icon_ver + 1 WHERE id = ?").bind(serverId).run();

    const fresh = await db.prepare("SELECT icon_ver FROM servers WHERE id = ?").bind(serverId).first();
    return json({ ok: true, iconUrl: serverIconUrl(serverId, fresh ? fresh.icon_ver : 1) });
  }

  const hooksMatch = /^\/api\/servers\/([^/]+)\/webhooks$/.exec(url.pathname);
  if (hooksMatch && method === "GET") {
    const serverId = decodeURIComponent(hooksMatch[1]);
    if (!(await canManage(db, serverId, me.sub, PERM.MANAGE_CHANNELS))) {
      return fail("You need the Manage channels permission to see webhooks.", 403);
    }

    const rows = await db
      .prepare("SELECT id, channel_id, name, token, created_at FROM webhooks WHERE server_id = ? ORDER BY created_at")
      .bind(serverId)
      .all();

    return json({
      webhooks: rows.results.map((row) => ({
        id: row.id,
        channelId: row.channel_id,
        name: row.name,
        url: "/api/webhooks/" + row.id + "/" + row.token,
        createdAt: row.created_at,
      })),
    });
  }

  if (hooksMatch && method === "POST") {
    const serverId = decodeURIComponent(hooksMatch[1]);
    if (!(await canManage(db, serverId, me.sub, PERM.MANAGE_CHANNELS))) {
      return fail("You need the Manage channels permission to add webhooks.", 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const channel = await db
      .prepare("SELECT id, name FROM channels WHERE id = ? AND server_id = ? AND is_logs = 0")
      .bind(String(body.channelId || ""), serverId)
      .first();
    if (!channel) return fail("Pick a channel in this server.");

    const name = String(body.name || "Webhook").trim().slice(0, 40) || "Webhook";
    const id = crypto.randomUUID();
    const token = randomToken(24);

    await db
      .prepare("INSERT INTO webhooks (id, server_id, channel_id, name, token, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, serverId, channel.id, name, token, now)
      .run();

    await logEvent(db, serverId, me.sub, "Webhook created", name + " → #" + channel.name);

    return json({ ok: true, webhook: { id, name, channelId: channel.id, url: "/api/webhooks/" + id + "/" + token } });
  }

  const hookDeleteMatch = /^\/api\/webhooks\/([^/]+)$/.exec(url.pathname);
  if (hookDeleteMatch && method === "DELETE") {
    const hookId = decodeURIComponent(hookDeleteMatch[1]);
    const hook = await db.prepare("SELECT id, server_id FROM webhooks WHERE id = ?").bind(hookId).first();
    if (!hook) return fail("That webhook no longer exists.", 404);
    if (!(await canManage(db, hook.server_id, me.sub, PERM.MANAGE_CHANNELS))) {
      return fail("You need the Manage channels permission to delete it.", 403);
    }

    await db.prepare("DELETE FROM webhooks WHERE id = ?").bind(hookId).run();
    await logEvent(db, hook.server_id, me.sub, "Webhook deleted", hookId);
    return json({ ok: true });
  }

  const channelEditMatch = /^\/api\/channels\/([^/]+)$/.exec(url.pathname);
  if (channelEditMatch && (method === "PATCH" || method === "DELETE")) {
    const channelId = decodeURIComponent(channelEditMatch[1]);
    const channel = await db
      .prepare("SELECT id, server_id, name, type, rules FROM channels WHERE id = ?")
      .bind(channelId)
      .first();
    if (!channel) return fail("That channel no longer exists.", 404);

    if (!(await canManage(db, channel.server_id, me.sub, PERM.MANAGE_CHANNELS))) {
      return fail("You need the Manage channels permission to do that.", 403);
    }

    if (method === "DELETE") {
      const count = await db
        .prepare("SELECT COUNT(*) AS n FROM channels WHERE server_id = ?")
        .bind(channel.server_id)
        .first();
      if (count && count.n <= 1) return fail("Keep at least one channel in the server.");

      await db.batch([
        db.prepare("DELETE FROM messages WHERE channel = ?").bind(channelId),
        db
          .prepare("DELETE FROM forum_replies WHERE post_id IN (SELECT id FROM forum_posts WHERE channel_id = ?)")
          .bind(channelId),
        db.prepare("DELETE FROM forum_posts WHERE channel_id = ?").bind(channelId),
        db.prepare("DELETE FROM voice_members WHERE channel_id = ?").bind(channelId),
        db.prepare("DELETE FROM voice_signals WHERE channel_id = ?").bind(channelId),
        db.prepare("DELETE FROM channels WHERE id = ?").bind(channelId),
      ]);

      await logEvent(db, channel.server_id, me.sub, "Channel deleted", "#" + channel.name);

      return json({ ok: true });
    }

    let editBody;
    try {
      editBody = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const wantsName = Object.prototype.hasOwnProperty.call(editBody, "name");
    const wantsRules = Object.prototype.hasOwnProperty.call(editBody, "rules");
    if (!wantsName && !wantsRules) return fail("Nothing to change.");
    if (wantsRules && channel.type !== "rules") return fail("Only rules channels hold rules.");

    let name = channel.name;
    if (wantsName) {
      name = String(editBody.name || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 24);

      if (!CHANNEL_RE.test(name)) return fail("Channel names use lowercase letters, numbers and dashes.");

      const taken = await db
        .prepare("SELECT 1 AS ok FROM channels WHERE server_id = ? AND name = ? AND id <> ?")
        .bind(channel.server_id, name, channelId)
        .first();
      if (taken) return fail("That channel already exists.", 409);
    }

    let rules = channel.rules || "";
    if (wantsRules) {
      rules = String(editBody.rules || "")
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join("\n")
        .slice(0, MAX_POST);
    }

    await db.prepare("UPDATE channels SET name = ?, rules = ? WHERE id = ?").bind(name, rules, channelId).run();
    return json({ ok: true, channel: { id: channelId, name, rules } });
  }

  if (url.pathname === "/api/state" && method === "GET") {
    const officialMember = await db
      .prepare("SELECT 1 AS ok FROM server_members WHERE server_id = ? AND user_sub = ?")
      .bind(OFFICIAL_SERVER_ID, me.sub)
      .first();

    if (!officialMember) {
      await db
        .prepare("INSERT OR IGNORE INTO server_members (server_id, user_sub, joined_at) VALUES (?, ?, ?)")
        .bind(OFFICIAL_SERVER_ID, me.sub, now)
        .run();
    }

    const [serverRows, friendRows, incomingRows, outgoingRows] = await db.batch([
      db.prepare(
        `SELECT s.id, s.name, s.owner_sub, s.invite_code, s.custom_code, s.icon_ver
           FROM servers s JOIN server_members m ON m.server_id = s.id
          WHERE m.user_sub = ?
          ORDER BY CASE WHEN s.id = ? THEN 0 ELSE 1 END, s.created_at`
      ).bind(me.sub, OFFICIAL_SERVER_ID),
      db.prepare(
        `SELECT u.sub, u.handle, u.display_name, u.avatar_ver, u.banner_ver,
                u.status_text, u.status_expires, u.presence,
                u.bio, u.pronouns, u.decor_json, u.decor_ver, u.socials_json, u.last_seen
           FROM friends f
           JOIN users u ON u.sub = CASE WHEN f.requester = ? THEN f.addressee ELSE f.requester END
          WHERE (f.requester = ? OR f.addressee = ?) AND f.status = 'accepted'
          ORDER BY u.display_name COLLATE NOCASE`
      ).bind(me.sub, me.sub, me.sub),
      db.prepare(
        `SELECT u.sub, u.handle, u.display_name, u.avatar_ver, u.banner_ver,
                u.status_text, u.status_expires, u.presence,
              u.bio, u.pronouns, u.decor_json, u.decor_ver, u.socials_json, f.created_at
           FROM friends f JOIN users u ON u.sub = f.requester
          WHERE f.addressee = ? AND f.status = 'pending'
          ORDER BY f.created_at DESC`
      ).bind(me.sub),
      db.prepare(
        `SELECT u.sub, u.handle, u.display_name, u.avatar_ver, u.banner_ver,
                u.status_text, u.status_expires, u.presence,
              u.bio, u.pronouns, u.decor_json, u.decor_ver, u.socials_json, f.created_at
           FROM friends f JOIN users u ON u.sub = f.addressee
          WHERE f.requester = ? AND f.status = 'pending'
          ORDER BY f.created_at DESC`
      ).bind(me.sub),
    ]);

    await db.batch([
      db.prepare("DELETE FROM voice_members WHERE last_seen < ?").bind(now - VOICE_STALE_MS),
      db.prepare("DELETE FROM voice_signals WHERE created_at < ?").bind(now - 2 * 60 * 1000),
    ]);

    const servers = serverRows.results;
    const serverQueries = [];
    servers.forEach((server) => {
      serverQueries.push(
        db
          .prepare(
            "SELECT id, name, topic, position, type, rules, is_logs, category FROM channels WHERE server_id = ? ORDER BY position, created_at"
          )
          .bind(server.id)
      );
      serverQueries.push(
        db
          .prepare(
            `SELECT u.sub, u.handle, u.display_name, u.avatar_ver, u.banner_ver,
                    u.status_text, u.status_expires, u.presence,
                u.bio, u.pronouns, u.decor_json, u.decor_ver, u.socials_json, u.last_seen
               FROM server_members m JOIN users u ON u.sub = m.user_sub
              WHERE m.server_id = ?
              ORDER BY u.display_name COLLATE NOCASE`
          )
          .bind(server.id)
      );
    });

    const serverDetails = serverQueries.length ? await db.batch(serverQueries) : [];

    const voiceRows = await db
      .prepare(
        `SELECT vm.channel_id, vm.muted, vm.sharing, u.sub, u.handle, u.display_name, u.avatar_ver, u.last_seen
           FROM voice_members vm
           JOIN channels c ON c.id = vm.channel_id
           JOIN server_members m ON m.server_id = c.server_id AND m.user_sub = ?
           JOIN users u ON u.sub = vm.user_sub
          WHERE vm.last_seen > ?
          ORDER BY vm.joined_at`
      )
      .bind(me.sub, now - VOICE_STALE_MS)
      .all();

    const voiceByChannel = {};
    voiceRows.results.forEach((row) => {
      const list = voiceByChannel[row.channel_id] || (voiceByChannel[row.channel_id] = []);
      list.push({ ...shapeMember(row, now), muted: !!row.muted, sharing: !!row.sharing });
    });

    const blockedRows = await db.prepare("SELECT blocked FROM blocks WHERE blocker = ?").bind(me.sub).all();
    const blockedSubs = blockedRows.results.map((row) => row.blocked);

    const shapedServers = servers.map((server, index) => {
      const channelsRes = serverDetails[index * 2];
      const membersRes = serverDetails[index * 2 + 1];
      return {
        id: server.id,
        name: server.name,
        inviteCode: server.custom_code || server.invite_code,
        defaultInviteCode: server.invite_code,
        iconUrl: serverIconUrl(server.id, server.icon_ver),
        verified: server.id === OFFICIAL_SERVER_ID,
        customCode: server.custom_code || "",
        isOwner: server.owner_sub === me.sub,
        channels: channelsRes.results.map((row) => ({
          id: row.id,
          name: row.name,
          topic: row.topic,
          type: row.type || "text",
          isLogs: !!row.is_logs,
          category: row.category || "",
          rules: row.type === "rules" ? row.rules || "" : "",
          voice: voiceByChannel[row.id] || [],
        })),
        members: membersRes.results.map((row) => shapeMember(row, now)),
      };
    });

    if (servers.length) {
      const ids = servers.map((server) => server.id);
      const marks = ids.map(() => "?").join(",");
      const [roleRows, assignRows] = await db.batch([
        db
          .prepare(
            `SELECT id, server_id, name, color, permissions, position FROM roles
              WHERE server_id IN (${marks}) ORDER BY position, created_at`
          )
          .bind(...ids),
        db
          .prepare(`SELECT server_id, user_sub, role_id FROM member_roles WHERE server_id IN (${marks})`)
          .bind(...ids),
      ]);

      const rolesByServer = {};
      roleRows.results.forEach((row) => {
        const list = rolesByServer[row.server_id] || (rolesByServer[row.server_id] = []);
        list.push({
          id: row.id,
          name: row.name,
          color: row.color,
          permissions: row.permissions,
          position: row.position,
        });
      });

      const rolesByMember = {};
      assignRows.results.forEach((row) => {
        const key = row.server_id + "|" + row.user_sub;
        (rolesByMember[key] || (rolesByMember[key] = [])).push(row.role_id);
      });

      shapedServers.forEach((server) => {
        server.roles = rolesByServer[server.id] || [];
        server.members.forEach((member) => {
          member.roleIds = rolesByMember[server.id + "|" + member.sub] || [];
        });
      });
    }

    const friends = friendRows.results.map((row) => shapeMember(row, now));

    const dmPreviews = friends.length
      ? await db.batch(
          friends.map((friend) =>
            db
              .prepare("SELECT body, created_at FROM messages WHERE channel = ? ORDER BY created_at DESC, id DESC LIMIT 1")
              .bind(dmChannel(me.sub, friend.sub))
          )
        )
      : [];

    const dms = friends.map((friend, index) => {
      const row = dmPreviews[index] && dmPreviews[index].results[0];
      return {
        channel: dmChannel(me.sub, friend.sub),
        friend,
        lastMessage: row ? { body: row.body, createdAt: row.created_at } : null,
      };
    });

    return json({
      me: {
        sub: me.sub,
        handle: me.handle,
        displayName: me.display_name,
        avatarUrl: avatarUrl(me.sub, me.avatar_ver),
        bannerUrl: bannerUrl(me.sub, me.banner_ver),
        bio: me.bio || "",
        pronouns: me.pronouns || "",
        decor: shapeDecor(me),
        socials: shapeSocials(me),
        statusText: me.status_expires && me.status_expires < now ? "" : me.status_text || "",
        statusUntil: me.status_expires || 0,
        presence: me.presence || "online",
        soundcloudUrl: me.soundcloud_url || "",
        profileCss: me.profile_css || "",
        profileHtml: me.profile_html || "",
        nameFont: me.name_font || "",
        nameColor1: me.name_color1 || "",
        nameColor2: me.name_color2 || "",
        nameGlow: me.name_glow || "",
        verified: !!me.verified || me.sub === OFFICIAL_BOT_SUB || ["sc0pes", "fleek"].includes(String(me.handle || "").toLowerCase()) || ["sc0pes", "fleek"].includes(String(me.display_name || "").toLowerCase()),
      },
      servers: shapedServers,
      friends,
      dms,
      blocked: blockedSubs,
      incoming: incomingRows.results.map((row) => ({
        ...shapeMember(row, now),
        requestedAt: row.created_at,
      })),
      outgoing: outgoingRows.results.map((row) => ({
        ...shapeMember(row, now),
        requestedAt: row.created_at,
      })),
    });
  }

  /* ---------------- directory + friends ---------------- */

  if (url.pathname === "/api/users" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 32);
    if (q.length < 1) return json({ users: [] });

    const res = await db
      .prepare(
        `SELECT sub, handle, display_name, avatar_ver, banner_ver,
                status_text, status_expires, presence,
                bio, pronouns, decor_json, decor_ver, socials_json, last_seen FROM users
          WHERE sub != ? AND (handle LIKE ? OR lower(display_name) LIKE ?)
          ORDER BY handle LIMIT 10`
      )
      .bind(me.sub, q + "%", "%" + q + "%")
      .all();

    return json({ users: res.results.map((row) => shapeMember(row, now)) });
  }

  if (url.pathname === "/api/friends/request" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const handle = String(body.handle || "").trim().toLowerCase();
    if (!HANDLE_RE.test(handle)) return fail("Enter a valid handle.");

    const target = await db.prepare("SELECT sub FROM users WHERE handle = ?").bind(handle).first();
    if (!target) return fail("No one here goes by @" + handle + ".", 404);
    if (target.sub === me.sub) return fail("You can't friend yourself.", 400);

    const existing = await db
      .prepare(
        `SELECT requester, addressee, status FROM friends
          WHERE (requester = ? AND addressee = ?) OR (requester = ? AND addressee = ?)`
      )
      .bind(me.sub, target.sub, target.sub, me.sub)
      .first();

    if (existing && existing.status === "accepted") return fail("You're already friends with @" + handle + ".", 409);
    if (existing && existing.requester === target.sub) {
      await db
        .prepare("UPDATE friends SET status = 'accepted' WHERE requester = ? AND addressee = ?")
        .bind(target.sub, me.sub)
        .run();
      return json({ ok: true, status: "accepted" });
    }
    if (existing) return json({ ok: true, status: "pending" });

    await db
      .prepare("INSERT INTO friends (requester, addressee, status, created_at) VALUES (?, ?, 'pending', ?)")
      .bind(me.sub, target.sub, now)
      .run();

    return json({ ok: true, status: "pending" });
  }

  if (url.pathname === "/api/friends/respond" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const handle = String(body.handle || "").trim().toLowerCase();
    const action = body.action === "decline" ? "decline" : "accept";

    const target = await db.prepare("SELECT sub FROM users WHERE handle = ?").bind(handle).first();
    if (!target) return fail("That account no longer exists.", 404);

    const pending = await db
      .prepare("SELECT requester FROM friends WHERE requester = ? AND addressee = ? AND status = 'pending'")
      .bind(target.sub, me.sub)
      .first();
    if (!pending) return fail("That request is no longer pending.", 404);

    if (action === "accept") {
      await db
        .prepare("UPDATE friends SET status = 'accepted' WHERE requester = ? AND addressee = ?")
        .bind(target.sub, me.sub)
        .run();
      return json({ ok: true, status: "accepted" });
    }

    await db
      .prepare("DELETE FROM friends WHERE requester = ? AND addressee = ?")
      .bind(target.sub, me.sub)
      .run();
    return json({ ok: true, status: "declined" });
  }

  if (url.pathname === "/api/friends/remove" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const handle = String(body.handle || "").trim().toLowerCase();
    const target = await db.prepare("SELECT sub FROM users WHERE handle = ?").bind(handle).first();
    if (!target) return fail("That account no longer exists.", 404);

    await db
      .prepare("DELETE FROM friends WHERE (requester = ? AND addressee = ?) OR (requester = ? AND addressee = ?)")
      .bind(me.sub, target.sub, target.sub, me.sub)
      .run();

    return json({ ok: true });
  }

  /* ---------------- messages ---------------- */

  if (url.pathname === "/api/messages" && method === "GET") {
    const channel = url.searchParams.get("channel") || "";
    const after = Number(url.searchParams.get("after")) || 0;

    if (!channel) return fail("Channel is required.");
    if (!(await canAccessChannel(db, channel, me.sub))) {
      return fail("You don't have access to that conversation.", 403);
    }

    const base = `SELECT m.id, m.channel, m.author_sub, m.body, m.created_at, m.files, m.kind, m.embeds,
                         u.handle, u.display_name, u.avatar_ver
                    FROM messages m JOIN users u ON u.sub = m.author_sub
                   WHERE m.channel = ?`;

    let rows;
    if (after > 0) {
      const res = await db
        .prepare(base + " AND m.created_at > ? ORDER BY m.created_at ASC, m.id ASC LIMIT 100")
        .bind(channel, after)
        .all();
      rows = res.results;
    } else {
      const res = await db
        .prepare(base + " ORDER BY m.created_at DESC, m.id DESC LIMIT 60")
        .bind(channel)
        .all();
      rows = res.results.slice().reverse();
    }

    const blockedSet = new Set(
      (await db.prepare("SELECT blocked FROM blocks WHERE blocker = ?").bind(me.sub).all()).results.map((row) => row.blocked)
    );
    rows = rows.filter((row) => !blockedSet.has(row.author_sub));

    const fileIds = [];
    rows.forEach((row) => {
      String(row.files || "")
        .split(",")
        .filter(Boolean)
        .forEach((id) => {
          if (fileIds.indexOf(id) === -1) fileIds.push(id);
        });
    });

    const uploadById = {};
    if (fileIds.length) {
      const uploadRes = await db
        .prepare(`SELECT id, name, mime, size FROM uploads WHERE id IN (${fileIds.map(() => "?").join(",")})`)
        .bind(...fileIds)
        .all();
      uploadRes.results.forEach((row) => {
        uploadById[row.id] = shapeUpload(row);
      });
    }

    return json({
      channel,
      messages: rows.map((row) => ({
        ...shapeMessage(row),
        kind: row.kind || "user",
        embeds: parseEmbeds(row.embeds),
        files: String(row.files || "")
          .split(",")
          .filter((id) => uploadById[id])
          .map((id) => uploadById[id]),
      })),
    });
  }

  if (url.pathname === "/api/messages" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const channel = String(body.channel || "");
    const text = String(body.body || "").replace(/\r\n/g, "\n").trim();

    const incomingFiles = Array.isArray(body.files)
      ? body.files.filter((value) => typeof value === "string").slice(0, 4)
      : [];
    if (!text && !incomingFiles.length) return fail("Message is empty.");
    if (text.length > MAX_BODY) return fail("Messages are limited to 2000 characters.");
    if (!(await canAccessChannel(db, channel, me.sub))) {
      return fail("You don't have access to that conversation.", 403);
    }

    if (!channel.startsWith("dm:")) {
      const target = await db
        .prepare("SELECT c.type, c.server_id, c.is_logs, s.owner_sub FROM channels c JOIN servers s ON s.id = c.server_id WHERE c.id = ?")
        .bind(channel)
        .first();
      if (!target) return fail("That channel no longer exists.", 404);
      if (target.type === "voice") return fail("Voice channels don't take text messages.");
      if (target.type === "forum") return fail("Forum channels use posts, not messages.");
      if (target.type === "rules") return fail("Rules channels are read-only.", 403);
      if (target.is_logs) return fail("The log channel is written by Fleek, not people.", 403);
      if (
        target.type === "announcement" &&
        !(await canManage(db, target.server_id, me.sub, PERM.ANNOUNCE))
      ) {
        return fail("You need the Announce permission to post here.", 403);
      }
    }

    let fileIds = incomingFiles;
    if (fileIds.length) {
      const owned = await db
        .prepare(`SELECT id FROM uploads WHERE owner_sub = ? AND id IN (${fileIds.map(() => "?").join(",")})`)
        .bind(me.sub, ...fileIds)
        .all();
      const allowed = new Set(owned.results.map((row) => row.id));
      fileIds = fileIds.filter((fileId) => allowed.has(fileId));
    }
    if (!text && !fileIds.length) return fail("Message is empty.");

    const id = crypto.randomUUID();
    await db
      .prepare("INSERT INTO messages (id, channel, author_sub, body, created_at, files) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, channel, me.sub, text, now, fileIds.join(","))
      .run();

    let files = [];
    if (fileIds.length) {
      const uploadRes = await db
        .prepare(`SELECT id, name, mime, size FROM uploads WHERE id IN (${fileIds.map(() => "?").join(",")})`)
        .bind(...fileIds)
        .all();
      files = uploadRes.results.map(shapeUpload);
    }

    return json({
      message: {
        id,
        channel,
        body: text,
        files,
        kind: "user",
        embeds: [],
        createdAt: now,
        author: {
          sub: me.sub,
          handle: me.handle,
          displayName: me.display_name,
          avatarUrl: avatarUrl(me.sub, me.avatar_ver),
          verified: !!me.verified || me.sub === OFFICIAL_BOT_SUB || ["sc0pes", "fleek"].includes(String(me.handle || "").toLowerCase()) || ["sc0pes", "fleek"].includes(String(me.display_name || "").toLowerCase()),
        },
      },
    });
  }

  /* ---------------- forums ---------------- */

  async function channelForMember(channelId, sub) {
    const row = await db
      .prepare(
        `SELECT c.id, c.server_id, c.name, c.type, s.owner_sub
           FROM channels c JOIN servers s ON s.id = c.server_id
          WHERE c.id = ?`
      )
      .bind(channelId)
      .first();
    if (!row) return null;
    if (!(await isServerMember(db, row.server_id, sub))) return null;
    return row;
  }

  function shapeForumAuthor(row) {
    return {
      sub: row.sub,
      handle: row.handle,
      displayName: row.display_name,
      avatarUrl: avatarUrl(row.sub, row.avatar_ver),
    };
  }

  const messageDeleteMatch = /^\/api\/messages\/([^/]+)$/.exec(url.pathname);
  if (messageDeleteMatch && method === "DELETE") {
    const messageId = decodeURIComponent(messageDeleteMatch[1]);
    const row = await db
      .prepare(
        `SELECT m.id, m.body, m.author_sub, m.channel, c.server_id
           FROM messages m LEFT JOIN channels c ON c.id = m.channel WHERE m.id = ?`
      )
      .bind(messageId)
      .first();
    if (!row) return fail("That message is gone already.", 404);

    const own = row.author_sub === me.sub;
    const allowed = own || (row.server_id && (await canManage(db, row.server_id, me.sub, PERM.MANAGE_CHANNELS)));
    if (!allowed) return fail("You can only delete your own messages here.", 403);

    await db.prepare("DELETE FROM messages WHERE id = ?").bind(messageId).run();

    if (row.server_id) {
      const excerpt = String(row.body || "").slice(0, 120) || "(attachment)";
      await logEvent(
        db,
        row.server_id,
        me.sub,
        own ? "Message deleted" : "Message removed by a moderator",
        "@" + me.handle + " deleted: " + excerpt
      );
    }

    return json({ ok: true });
  }

  if (url.pathname === "/api/forum" && method === "GET") {
    const channelId = url.searchParams.get("channel") || "";
    const channel = await channelForMember(channelId, me.sub);
    if (!channel) return fail("You don't have access to that forum.", 403);
    if (channel.type !== "forum") return fail("That channel isn't a forum.");

    const res = await db
      .prepare(
        `SELECT p.id, p.title, p.body, p.created_at,
                u.sub, u.handle, u.display_name, u.avatar_ver,
                (SELECT COUNT(*) FROM forum_replies r WHERE r.post_id = p.id) AS replies,
                (SELECT MAX(r.created_at) FROM forum_replies r WHERE r.post_id = p.id) AS last_reply
           FROM forum_posts p JOIN users u ON u.sub = p.author_sub
          WHERE p.channel_id = ?
          ORDER BY COALESCE(last_reply, p.created_at) DESC
          LIMIT 100`
      )
      .bind(channelId)
      .all();

    return json({
      channel: channelId,
      posts: res.results.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        createdAt: row.created_at,
        replies: row.replies || 0,
        lastReply: row.last_reply || null,
        author: shapeForumAuthor(row),
      })),
    });
  }

  if (url.pathname === "/api/forum" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const channel = await channelForMember(String(body.channel || ""), me.sub);
    if (!channel) return fail("You don't have access to that forum.", 403);
    if (channel.type !== "forum") return fail("That channel isn't a forum.");

    const title = String(body.title || "").trim().replace(/\s+/g, " ").slice(0, 90);
    const text = String(body.body || "").replace(/\r\n/g, "\n").trim().slice(0, MAX_POST);
    if (title.length < 3) return fail("Give your post a title (3–90 characters).");
    if (!text) return fail("Write something in your post.");

    const id = crypto.randomUUID();
    await db
      .prepare("INSERT INTO forum_posts (id, channel_id, author_sub, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, channel.id, me.sub, title, text, now)
      .run();

    return json({ ok: true, post: { id, title, body: text, createdAt: now } });
  }

  if (url.pathname === "/api/forum/post" && method === "GET") {
    const postId = url.searchParams.get("id") || "";
    const post = await db
      .prepare(
        `SELECT p.id, p.channel_id, p.title, p.body, p.created_at, p.author_sub
           FROM forum_posts p WHERE p.id = ?`
      )
      .bind(postId)
      .first();
    if (!post) return fail("That post no longer exists.", 404);

    const channel = await channelForMember(post.channel_id, me.sub);
    if (!channel) return fail("You don't have access to that forum.", 403);

    const [authorRow, replyRows] = await db.batch([
      db
        .prepare("SELECT sub, handle, display_name, avatar_ver FROM users WHERE sub = ?")
        .bind(post.author_sub),
      db
        .prepare(
          `SELECT r.id, r.body, r.created_at, u.sub, u.handle, u.display_name, u.avatar_ver
             FROM forum_replies r JOIN users u ON u.sub = r.author_sub
            WHERE r.post_id = ? ORDER BY r.created_at ASC, r.id ASC LIMIT 300`
        )
        .bind(post.id),
    ]);

    return json({
      post: {
        id: post.id,
        channel: post.channel_id,
        title: post.title,
        body: post.body,
        createdAt: post.created_at,
        author: authorRow.results[0] ? shapeForumAuthor(authorRow.results[0]) : null,
        canDelete: post.author_sub === me.sub || channel.owner_sub === me.sub,
      },
      replies: replyRows.results.map((row) => ({
        id: row.id,
        body: row.body,
        createdAt: row.created_at,
        author: shapeForumAuthor(row),
      })),
    });
  }

  if (url.pathname === "/api/forum/reply" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const post = await db
      .prepare("SELECT id, channel_id FROM forum_posts WHERE id = ?")
      .bind(String(body.post || ""))
      .first();
    if (!post) return fail("That post no longer exists.", 404);

    const channel = await channelForMember(post.channel_id, me.sub);
    if (!channel) return fail("You don't have access to that forum.", 403);

    const text = String(body.body || "").replace(/\r\n/g, "\n").trim();
    if (!text) return fail("Reply is empty.");
    if (text.length > MAX_BODY) return fail("Replies are limited to 2000 characters.");

    const id = crypto.randomUUID();
    await db
      .prepare("INSERT INTO forum_replies (id, post_id, author_sub, body, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, post.id, me.sub, text, now)
      .run();

    return json({ ok: true, reply: { id, body: text, createdAt: now } });
  }

  if (url.pathname === "/api/forum/post" && method === "DELETE") {
    const postId = url.searchParams.get("id") || "";
    const post = await db.prepare("SELECT id, channel_id, author_sub FROM forum_posts WHERE id = ?").bind(postId).first();
    if (!post) return fail("That post no longer exists.", 404);

    const channel = await channelForMember(post.channel_id, me.sub);
    if (!channel) return fail("You don't have access to that forum.", 403);
    if (post.author_sub !== me.sub && channel.owner_sub !== me.sub) {
      return fail("Only the author or the server owner can delete this post.", 403);
    }

    await db.batch([
      db.prepare("DELETE FROM forum_replies WHERE post_id = ?").bind(post.id),
      db.prepare("DELETE FROM forum_posts WHERE id = ?").bind(post.id),
    ]);

    return json({ ok: true });
  }

  /* ---------------- voice + screen share (WebRTC signalling) ---------------- */

  async function voiceParticipants(channelId) {
    const res = await db
      .prepare(
        `SELECT u.sub, u.handle, u.display_name, u.avatar_ver, u.last_seen, vm.muted, vm.sharing
           FROM voice_members vm JOIN users u ON u.sub = vm.user_sub
          WHERE vm.channel_id = ? AND vm.last_seen > ?
          ORDER BY vm.joined_at`
      )
      .bind(channelId, now - VOICE_STALE_MS)
      .all();

    return res.results.map((row) => ({ ...shapeMember(row, now), muted: !!row.muted, sharing: !!row.sharing }));
  }

  if (url.pathname === "/api/voice/join" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const channelId = String(body.channel || "");
    const channel = await channelForMember(channelId, me.sub);
    if (!channel) return fail("You don't have access to that voice channel.", 403);
    if (channel.type !== "voice") return fail("That channel isn't a voice channel.");

    await db.batch([
      db
        .prepare(
          `INSERT INTO voice_members (channel_id, user_sub, muted, sharing, joined_at, last_seen)
                VALUES (?, ?, 0, 0, ?, ?)
           ON CONFLICT(channel_id, user_sub) DO UPDATE SET last_seen = excluded.last_seen`
        )
        .bind(channelId, me.sub, now, now),
      db.prepare("DELETE FROM voice_members WHERE channel_id = ? AND last_seen < ?").bind(channelId, now - VOICE_STALE_MS),
    ]);

    return json({ ok: true, channel: channelId, self: me.sub, participants: await voiceParticipants(channelId) });
  }

  if (url.pathname === "/api/voice/leave" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const channelId = String(body.channel || "");
    await db.batch([
      db.prepare("DELETE FROM voice_members WHERE channel_id = ? AND user_sub = ?").bind(channelId, me.sub),
      db
        .prepare("DELETE FROM voice_signals WHERE channel_id = ? AND (from_sub = ? OR to_sub = ?)")
        .bind(channelId, me.sub, me.sub),
    ]);

    return json({ ok: true });
  }

  if (url.pathname === "/api/voice/ping" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const channelId = String(body.channel || "");
    const channel = await channelForMember(channelId, me.sub);
    if (!channel || channel.type !== "voice") return fail("That voice channel is gone.", 404);

    await db
      .prepare(
        `INSERT INTO voice_members (channel_id, user_sub, muted, sharing, joined_at, last_seen)
              VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, user_sub)
         DO UPDATE SET last_seen = excluded.last_seen, muted = excluded.muted, sharing = excluded.sharing`
      )
      .bind(channelId, me.sub, body.muted ? 1 : 0, body.sharing ? 1 : 0, now, now)
      .run();

    return json({ ok: true, participants: await voiceParticipants(channelId) });
  }

  if (url.pathname === "/api/voice/signal" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const channelId = String(body.channel || "");
    const to = String(body.to || "");
    const kind = String(body.kind || "");
    if (["offer", "answer", "ice", "bye"].indexOf(kind) === -1) return fail("Unknown signal type.");

    const channel = await channelForMember(channelId, me.sub);
    if (!channel || channel.type !== "voice") return fail("That voice channel is gone.", 404);

    // Only whisper to someone who is actually in this room right now.
    const peer = await db
      .prepare("SELECT 1 AS ok FROM voice_members WHERE channel_id = ? AND user_sub = ? AND last_seen > ?")
      .bind(channelId, to, now - VOICE_STALE_MS)
      .first();
    if (!peer) return json({ ok: true, skipped: true });

    const payload = JSON.stringify(body.payload == null ? {} : body.payload);
    if (payload.length > SIGNAL_MAX) return fail("Signal too large.", 413);

    await db
      .prepare(
        "INSERT INTO voice_signals (channel_id, from_sub, to_sub, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(channelId, me.sub, to, kind, payload, now)
      .run();

    return json({ ok: true });
  }

  if (url.pathname === "/api/voice/signals" && method === "GET") {
    const channelId = url.searchParams.get("channel") || "";
    const since = Number(url.searchParams.get("since")) || 0;

    const channel = await channelForMember(channelId, me.sub);
    if (!channel || channel.type !== "voice") return fail("That voice channel is gone.", 404);

    const res = await db
      .prepare(
        `SELECT id, from_sub, kind, payload FROM voice_signals
          WHERE channel_id = ? AND to_sub = ? AND id > ?
          ORDER BY id LIMIT 60`
      )
      .bind(channelId, me.sub, since)
      .all();

    if (res.results.length) {
      await db.batch(res.results.map((row) => db.prepare("DELETE FROM voice_signals WHERE id = ?").bind(row.id)));
    }

    return json({
      signals: res.results.map((row) => ({ id: row.id, from: row.from_sub, kind: row.kind, payload: row.payload })),
      cursor: res.results.length ? res.results[res.results.length - 1].id : since,
    });
  }

  /* ---------------- banners ---------------- */

  if (url.pathname.startsWith("/api/banner/") && method === "GET") {
    if (!env.FILES) return fail("Image storage is not configured yet.", 500);

    const sub = decodeURIComponent(url.pathname.slice("/api/banner/".length));
    if (!sub || sub.length > 80) return fail("Unknown banner.", 404);

    const object = await env.FILES.get("banners/" + sub);
    if (!object) return new Response(null, { status: 404 });

    return new Response(object.body, {
      headers: {
        "content-type": (object.httpMetadata && object.httpMetadata.contentType) || "image/webp",
        "cache-control": "public, max-age=31536000, immutable",
        etag: object.httpEtag,
      },
    });
  }

  if (url.pathname === "/api/banner" && (method === "POST" || method === "DELETE")) {
    if (!env.FILES) return fail("Image storage is not configured yet.", 500);

    if (method === "DELETE") {
      await env.FILES.delete("banners/" + me.sub);
      await db.prepare("UPDATE users SET banner_ver = banner_ver + 1 WHERE sub = ?").bind(me.sub).run();
      return json({ ok: true, bannerUrl: null });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ""));
    if (!match) return fail("Upload a PNG, JPEG, WebP or GIF image.");
    if (match[2].length > 4200000) return fail("That banner is too large. Try a smaller one.", 413);

    const bytes = base64ToBytes(match[2]);
    if (!looksLikeImage(bytes)) return fail("That file isn't a valid image.");
    if (bytes.byteLength > 3000000) return fail("That banner is too large. Try a smaller one.", 413);

    await env.FILES.put("banners/" + me.sub, bytes, {
      httpMetadata: { contentType: match[1], cacheControl: "public, max-age=31536000, immutable" },
    });
    await db.prepare("UPDATE users SET banner_ver = banner_ver + 1 WHERE sub = ?").bind(me.sub).run();

    const fresh = await db.prepare("SELECT banner_ver FROM users WHERE sub = ?").bind(me.sub).first();
    return json({ ok: true, bannerUrl: bannerUrl(me.sub, fresh ? fresh.banner_ver : 1) });
  }

  /* ---------------- uploads + files ---------------- */

  if (url.pathname === "/api/upload" && method === "POST") {
    if (!env.FILES) return fail("File storage is not configured yet.", 500);

    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > MAX_UPLOAD + 200000) return fail("That file is too large (10 MB max).", 413);

    let form;
    try {
      form = await request.formData();
    } catch {
      return fail("Upload a file.");
    }

    const file = form.get("file");
    if (!file || typeof file === "string") return fail("Upload a file.");
    if (file.size > MAX_UPLOAD) return fail("That file is too large (10 MB max).", 413);

    const mime = String(file.type || "application/octet-stream").toLowerCase().slice(0, 120);
    if (BLOCKED_UPLOAD_MIMES.has(mime)) return fail("That file type isn't allowed.");

    const name = String(file.name || "file")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
      .trim()
      .slice(0, 80) || "file";

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > MAX_UPLOAD) return fail("That file is too large (10 MB max).", 413);

    const id = crypto.randomUUID();
    const key = "files/" + me.sub + "/" + id;

    await env.FILES.put(key, bytes, {
      httpMetadata: { contentType: mime, cacheControl: "private, max-age=3600" },
    });
    await db
      .prepare("INSERT INTO uploads (id, owner_sub, name, mime, size, key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, me.sub, name, mime, bytes.byteLength, key, now)
      .run();

    return json({
      ok: true,
      file: { id, name, mime, size: bytes.byteLength, url: fileUrl(id) },
    });
  }

  if (url.pathname.startsWith("/api/files/") && method === "GET") {
    if (!env.FILES) return fail("File storage is not configured yet.", 500);

    const id = decodeURIComponent(url.pathname.slice("/api/files/".length));
    if (!id) return fail("Unknown file.", 404);

    const upload = await db
      .prepare("SELECT id, owner_sub, name, mime, size, key FROM uploads WHERE id = ?")
      .bind(id)
      .first();
    if (!upload) return fail("Unknown file.", 404);

    if (upload.owner_sub !== me.sub) {
      // A file is readable by anyone who can read a message that carries it.
      const refs = await db
        .prepare("SELECT channel FROM messages WHERE files LIKE ? LIMIT 5")
        .bind("%" + upload.id + "%")
        .all();

      let allowed = false;
      for (const ref of refs.results) {
        if (await canAccessChannel(db, ref.channel, me.sub)) {
          allowed = true;
          break;
        }
      }
      if (!allowed) return fail("You don't have access to that file.", 403);
    }

    const object = await env.FILES.get(upload.key);
    if (!object) return fail("That file is gone.", 404);

    const inline = upload.mime.startsWith("image/");
    const headers = new Headers({
      "content-type": upload.mime,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-disposition":
        (inline ? "inline" : "attachment") + "; filename*=UTF-8''" + encodeURIComponent(upload.name),
    });
    if (object.httpEtag) headers.set("etag", object.httpEtag);

    return new Response(object.body, { headers });
  }

  /* ---------------- status + public profile ---------------- */

  if (url.pathname === "/api/status" && method === "POST") {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, STATUS_MAX);
    const presence = ["online", "idle", "dnd", "offline"].includes(String(body.presence))
      ? String(body.presence)
      : "online";
    const minutes = Math.max(0, Math.min(Number(body.minutes) || 0, 7 * 24 * 60));
    const until = text && minutes > 0 ? now + minutes * 60000 : 0;

    await db
      .prepare("UPDATE users SET status_text = ?, status_expires = ?, presence = ? WHERE sub = ?")
      .bind(text, until, presence, me.sub)
      .run();

    return json({ ok: true, statusText: text, statusUntil: until, presence });
  }

  const publicProfile = /^\/api\/profile\/([^/]+)$/.exec(url.pathname);
  if (publicProfile && method === "GET") {
    const sub = decodeURIComponent(publicProfile[1]);
    const row = await db
      .prepare(
        `SELECT sub, handle, display_name, avatar_ver, banner_ver, status_text, status_expires,
                presence, bio, pronouns, decor_json, decor_ver, socials_json,
                soundcloud_url, soundcloud_json, profile_css, profile_html, last_seen
           FROM users WHERE sub = ?`
      )
      .bind(sub)
      .first();
    if (!row) return fail("That person isn't here anymore.", 404);

    let soundcloud = null;
    if (row.soundcloud_url) {
      let meta = {};
      try {
        meta = JSON.parse(row.soundcloud_json || "{}");
      } catch {
        meta = {};
      }
      soundcloud = {
        url: row.soundcloud_url,
        title: meta.title || "SoundCloud",
        author: meta.author || "",
        art: meta.art || "",
      };
    }

    return json({
      profile: {
        sub: row.sub,
        handle: row.handle,
        displayName: row.display_name,
        avatarUrl: avatarUrl(row.sub, row.avatar_ver),
        bannerUrl: bannerUrl(row.sub, row.banner_ver),
        statusText: row.status_expires && row.status_expires < now ? "" : row.status_text || "",
        statusUntil: row.status_expires || 0,
        presence: row.presence || "online",
        online: (row.presence || "online") !== "offline" && now - row.last_seen < ONLINE_MS,
        soundcloud,
        bio: row.bio || "",
        pronouns: row.pronouns || "",
        decor: shapeDecor(row),
        socials: shapeSocials(row),
        nameFont: row.name_font || "",
        nameColor1: row.name_color1 || "",
        nameColor2: row.name_color2 || "",
        nameGlow: row.name_glow || "",
        verified: !!row.verified || row.sub === OFFICIAL_BOT_SUB || ["sc0pes", "fleek"].includes(String(row.handle || "").toLowerCase()) || ["sc0pes", "fleek"].includes(String(row.display_name || "").toLowerCase()),
        blockedByMe: !!(await db
          .prepare("SELECT 1 AS ok FROM blocks WHERE blocker = ? AND blocked = ?")
          .bind(me.sub, sub)
          .first()),
        css: row.profile_css || "",
        html: row.profile_html || "",
      },
    });
  }

  /* ---------------- invites ---------------- */

  const inviteMatch = /^\/api\/servers\/([^/]+)\/invite$/.exec(url.pathname);
  if (inviteMatch && method === "PATCH") {
    const serverId = decodeURIComponent(inviteMatch[1]);
    if (!(await isServerMember(db, serverId, me.sub))) return fail("You're not in that server.", 403);
    if (!(await canManage(db, serverId, me.sub, PERM.MANAGE_CHANNELS))) {
      return fail("You need the Manage channels permission to change invites.", 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const raw = String(body.code || "").trim().toLowerCase();
    const code = raw.replace(/[^a-z0-9-]/g, "").slice(0, 24);

    if (code && !/^[a-z0-9][a-z0-9-]{2,23}$/.test(code)) {
      return fail("Custom invites are 3–24 letters, numbers or dashes.");
    }

    if (code) {
      const taken = await db
        .prepare("SELECT 1 AS ok FROM servers WHERE (custom_code = ? OR invite_code = ?) AND id <> ?")
        .bind(code, code, serverId)
        .first();
      if (taken) return fail("That custom invite is already taken.", 409);
    }

    await db.prepare("UPDATE servers SET custom_code = ? WHERE id = ?").bind(code || null, serverId).run();

    const row = await db.prepare("SELECT invite_code, custom_code FROM servers WHERE id = ?").bind(serverId).first();
    const active = row.custom_code || row.invite_code;

    return json({ ok: true, customCode: row.custom_code || "", inviteCode: active, link: "/invite/" + active });
  }

  /* ---------------- roles + permissions ---------------- */

  function rolePayload(body) {
    const name = String(body.name || "").trim().replace(/\s+/g, " ").slice(0, 32);
    const color = /^#[0-9a-f]{6}$/i.test(String(body.color || "")) ? String(body.color).toLowerCase() : "";
    const permissions = Math.max(0, Math.min(Number(body.permissions) || 0, 7));
    return { name, color, permissions };
  }

  const rolesMatch = /^\/api\/servers\/([^/]+)\/roles$/.exec(url.pathname);
  if (rolesMatch && method === "POST") {
    const serverId = decodeURIComponent(rolesMatch[1]);
    if (!(await canManage(db, serverId, me.sub, PERM.MANAGE_ROLES))) {
      return fail("You need the Manage roles permission to do that.", 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const payload = rolePayload(body);
    if (!payload.name) return fail("Give the role a name.");

    const count = await db.prepare("SELECT COUNT(*) AS n FROM roles WHERE server_id = ?").bind(serverId).first();
    const id = crypto.randomUUID();

    await db
      .prepare(
        "INSERT INTO roles (id, server_id, name, color, permissions, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(id, serverId, payload.name, payload.color, payload.permissions, count ? count.n : 0, now)
      .run();

    return json({ ok: true, role: { id, ...payload } });
  }

  const assignMatch = /^\/api\/servers\/([^/]+)\/roles\/assign$/.exec(url.pathname);
  if (assignMatch && method === "POST") {
    const serverId = decodeURIComponent(assignMatch[1]);
    if (!(await canManage(db, serverId, me.sub, PERM.MANAGE_ROLES))) {
      return fail("You need the Manage roles permission to do that.", 403);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const target = String(body.user || "");
    const roleId = String(body.role || "");
    const add = body.action !== "remove";

    if (!(await isServerMember(db, serverId, target))) return fail("That person isn't in this server.", 404);

    const role = await db
      .prepare("SELECT id FROM roles WHERE id = ? AND server_id = ?")
      .bind(roleId, serverId)
      .first();
    if (!role) return fail("That role doesn't exist here.", 404);

    if (add) {
      await db
        .prepare("INSERT OR IGNORE INTO member_roles (server_id, user_sub, role_id) VALUES (?, ?, ?)")
        .bind(serverId, target, roleId)
        .run();
    } else {
      await db
        .prepare("DELETE FROM member_roles WHERE server_id = ? AND user_sub = ? AND role_id = ?")
        .bind(serverId, target, roleId)
        .run();
    }

    return json({ ok: true });
  }

  const roleMatch = /^\/api\/roles\/([^/]+)$/.exec(url.pathname);
  if (roleMatch && (method === "PATCH" || method === "DELETE")) {
    const roleId = decodeURIComponent(roleMatch[1]);
    const role = await db.prepare("SELECT id, server_id FROM roles WHERE id = ?").bind(roleId).first();
    if (!role) return fail("That role no longer exists.", 404);
    if (!(await canManage(db, role.server_id, me.sub, PERM.MANAGE_ROLES))) {
      return fail("You need the Manage roles permission to do that.", 403);
    }

    if (method === "DELETE") {
      await db.batch([
        db.prepare("DELETE FROM member_roles WHERE role_id = ?").bind(roleId),
        db.prepare("DELETE FROM roles WHERE id = ?").bind(roleId),
      ]);
      return json({ ok: true });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return fail("Invalid request body.");
    }

    const payload = rolePayload(body);
    if (!payload.name) return fail("Give the role a name.");

    await db
      .prepare("UPDATE roles SET name = ?, color = ?, permissions = ? WHERE id = ?")
      .bind(payload.name, payload.color, payload.permissions, roleId)
      .run();

    return json({ ok: true, role: { id: roleId, ...payload } });
  }

  return fail("Not found.", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);

    // A standalone marketing route, even for signed-in visitors.
    if (url.pathname === "/landing" || url.pathname === "/landing/" || url.pathname === "/welcome") {
      const shell = await env.ASSETS.fetch(new URL("/", url).toString());
      return new Response(shell.body, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }

    // Pretty invite links: /invite/<code> is the app; the client reads the code.
    if (url.pathname.startsWith("/invite/")) {
      const shell = await env.ASSETS.fetch(new URL("/", url).toString());
      const fresh = new Response(shell.body, shell);
      fresh.headers.set("cache-control", "no-store, must-revalidate");
      fresh.headers.set("pragma", "no-cache");
      return fresh;
    }

    const response = await env.ASSETS.fetch(request);
    const type = response.headers.get("content-type") || "";

    // The shell is the entry point for every deploy: make sure a browser or
    // edge never serves yesterday's HTML against today's assets.
    if (type.includes("text/html")) {
      const fresh = new Response(response.body, response);
      fresh.headers.set("cache-control", "no-store, must-revalidate");
      fresh.headers.set("pragma", "no-cache");
      return fresh;
    }

    return response;
  },
};
