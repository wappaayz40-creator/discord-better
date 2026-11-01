# Fleek

A small community chat that starts empty, requires an account, and looks like
Discord. No email, no third-party login, no nitro.

Live: <https://fleek.fleek-5b7255.workers.dev>

## Accounts

- **Handle + password.** Creating an account asks for a handle, a display name
  and a password. There is no email field and no OAuth provider.
- **Passwords** are hashed with PBKDF2-SHA256 (100,000 iterations, the
  platform maximum on workerd) and a 16-byte random salt per account. Only the
  hash is stored.
- **Sessions** are random 256-bit tokens sent in an `HttpOnly; SameSite=Lax`
  cookie; D1 stores only the SHA-256 of the token, so a database dump can't be
  replayed as a login. Sessions last 30 days.
- **Login throttling** counts attempts per IP in a 15-minute window and returns
  429 after 25 failures.
- Every state-changing request is rejected with 403 unless it comes from the
  site's own origin.

## What's real

- **Storage** — D1 tables `users`, `credentials`, `sessions`, `friends`,
  `messages`, `servers`, `server_members`, `channels`, `forum_posts`,
  `forum_replies`, `voice_members`, `voice_signals` (plus `auth_attempts`).
- **Servers** — anyone can create a server from the `+` in the left rail. Every
  server starts with `#general`, `#announcements`, `#rules`, `#forum` and a
  **General** voice room, and owners can add more channels from the `+` next to
  the CHANNELS header.
- **Channel types** — the create dialog offers **Text**, **Voice**, **Forum**,
  **Announcement** and **Rules**. The sidebar groups voice rooms under VOICE
  CHANNELS and gives each type its own icon.
- **Voice + screen share** — joining a voice channel opens a peer-to-peer
  WebRTC mesh: microphone audio, mute/unmute, and screen share with a LIVE
  badge and video tile for everyone in the room. The Worker only relays SDP and
  ICE through `voice_signals`; media never touches the server and nothing is
  recorded. Presence is a 5-second heartbeat pruned after 45 seconds.
- **Forums** — a forum channel lists posts (title, author, reply count, last
  activity). Anyone in the server can start a post, open it and reply; the
  author or server owner can delete a post with its replies. Post bodies render
  the same markdown subset as messages.
- **Announcements** — only the server owner can post; everyone else reads, and
  the composer is replaced with a read-only note. The API enforces this too
  (403), not just the UI.
- **Rules** — a read-only channel listing one rule per line. The owner edits it
  from the header or the channel right-click menu; every member sees the list
  and the API refuses rule edits from anyone else.
- **Invites** — each server has a shareable invite code (Invite people button).
  Another account joins with Home → Create or join a server → Join with code,
  then sees the server, its channels and its history.
- **Server membership** — channel reads and writes are checked server-side
  against `server_members`, so a non-member can't fetch a channel by id.
- **Right-click menus** — right-click a server icon for Invite People, Create
  Channel, Copy Invite Code, and Delete Server (owner) or Leave Server
  (member). Right-click a channel for Copy Link, Copy Channel Name, and
  Rename/Delete Channel (owner). Deleting asks for confirmation first.
- **Friends** — search by handle, send a request, accept or decline; only
  accepted friends can open a DM.
- **DMs** — channel id `dm:<sub-a>|<sub-b>`, access re-checked server-side on
  every read and write.
- **Profile photos** — cropped to 256×256 in the browser, stored in R2 (`FILES`)
  and served from `/api/avatar/<sub>?v=<n>` with an immutable cache.
- **Private by default** — there is no global people directory. A server's
  panel lists only that server's members; Home lists only your friends. The one
  way to find someone is an explicit handle search when adding a friend.
- **Attachments** — files up to 10 MB upload to R2 and appear in the message
  (images inline, other files as a download chip). A file is only served to
  people who can read a message carrying it. HTML, SVG and scripts are refused.
- **Banners and animated avatars** — profile banners up to 3 MB and GIF avatars
  that keep their animation (static images are resized in the browser). Both
  live in R2. Clicking your own avatar opens your profile card, the way Discord
  does; Edit profile is a button on that card.
- **Formatting** — bold, italic, strikethrough, inline code, spoiler and quote
  buttons above the composer, plus Ctrl/Cmd+B and Ctrl/Cmd+I. The same markdown
  subset renders in messages, forum posts and replies.
- **Animated branding** — the loading screen pulses the Fleek mark inside a
  spinning ring with a sweeping bar, then fades into the app. The same image is
  the favicon, the rail logo and the sign-in mark, and motion is disabled for
  anyone whose system asks for reduced motion.
- **Blank start** — a new account sees an empty room and only itself in the
  member list. Nothing is pre-seeded.
- **Settings** — a Discord-style dialog with My Account, My Profile and
  Appearance, where the theme lives.

## Themes

Three, like Discord ships them: **Dark** (default), **Midnight** (true black)
and **Light**. They are custom-property sets on `<html data-theme>` in
`css/tokens.css`, chosen in Settings → Appearance and remembered per device.

## Layout

```
worker.js          Worker: password auth, sessions, JSON API, D1, R2, assets
build.mjs          Bundles the Worker and copies the client into freebuff-sites-build/
wrangler.jsonc     Local workerd dev config (local D1 + R2)
index.html         Shell: auth screen, app grid, icon sprite
css/tokens.css     Base tokens + Light/Dark/Midnight themes
css/app.css        Rail, channel list, chat, composer, members
css/settings.css   Auth form + settings dialog + theme picker
css/servers.css    Server rail icons, invite code, emoji sizing, voice/forum/rules UI
css/ui.css         Splash animation, motion, banners, composer toolbar, attachments
js/app.js          Client: auth, servers, channels, DMs, friends, settings, polling
js/voice.js        WebRTC voice mesh + screen share, signalling over the API
js/markdown.js     Markdown subset + tiny highlighter
js/emoji.js        Emoji registry, Twemoji renderer, `:name:` search
```

## Run locally

```bash
npm install
node build.mjs
npx wrangler dev --config wrangler.jsonc --port 8787
```

Local D1 and R2 state lives under `.wrangler/state`. Open
<http://localhost:8787>, create an account, and everything works offline of any
external service.

## Deploy

```bash
node build.mjs
```

then deploy `freebuff-sites-build/manifest.json` through Freebuff Sites. The
`DB` (D1) and `FILES` (R2) bindings are attached by the platform.

## Verified

End-to-end against local workerd with real D1 and R2: sign up, empty home,
create a server, send a message, create a channel, copy the invite code, have a
second account join by that code, see the first account's history, reply, and
see the reply from the first account. Also checked: short passwords return 400,
foreign `Origin` returns 403, and `/api/*` returns 401 when signed out.

Channel types, two accounts in one server: sidebar shows TEXT and VOICE
groups; both accounts join the voice room, reach `connected` and receive each
other's microphone audio in both directions; screen share produces a remote
video track and LIVE badge;
leaving removes them from the room. A forum post is created by one account,
read and replied to by the other, and the reply count updates. Announcements are
posted by the owner only, while the member sees the read-only note, no composer
and a 403 from the API. Rules render for both, the owner edits them, the member
sees the fresh list and is refused (403) by the API. Text channels keep working,
and POSTing text into a voice channel returns 400.

Against production (`https://fleeks.freebuff.page`): signup, session cookie,
login, wrong-password 401, server creation, invite-code join by a second
account, cross-account message read/write, and 403 on a foreign origin.

## Limits

- Updates arrive by polling: 4 seconds for messages, 1 second for voice
  signalling and 5 seconds for voice presence. There are no websockets.
- Voice and screen share are peer-to-peer with public STUN only. That works for
  most home networks, but strict/symmetric NATs or firewalls without UDP need a
  TURN relay, which this deployment doesn't have. Audio is not recorded.
- Voice is a full mesh, so it stays comfortable for a handful of people in a
  room; it is not built for large calls.
- No group DMs yet (servers are the group space), no reactions, no message
  search, and messages are not end-to-end encrypted: the Worker can read what
  it stores. Real E2EE needs per-conversation key exchange and key rotation on
  membership change, which is a project of its own rather than a toggle.
- Password reset is not implemented — there is no email to reset through.
- Right-click and the F12 / Ctrl+Shift+I style shortcuts are blocked to make
  casual inspecting harder, but this is a deterrent only: anyone determined
  can still read the client bundle and call the API directly.
