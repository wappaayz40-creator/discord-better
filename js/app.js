/* ============================================================
   Fleek · client
   Handle + password accounts, user-created servers with their
   own channels, DMs, friends and per-device themes.
   ============================================================ */

(function () {
  "use strict";

  var $ = function (sel, root) {
    return (root || document).querySelector(sel);
  };

  var THEMES = [
    { id: "dark", label: "Dark", swatch: ["#313338", "#1e1f22", "#5865f2"] },
    { id: "midnight", label: "Midnight", swatch: ["#000000", "#121214", "#5865f2"] },
    { id: "light", label: "Light", swatch: ["#ffffff", "#e3e5e8", "#5865f2"] },
  ];

  var S = {
    session: null,
    data: null,
    mode: "home", // home | friends | channel
    friendsTab: "all", // all | pending | add
    serverId: null,
    channelId: null,
    dm: null,
    messages: [],
    lastTs: 0,
    timer: null,
    stateAt: 0,
    theme: localStorage.getItem("fleek:theme:v3") || "dark",
    pendingAvatar: null,
    authMode: "login",
    settingsSection: "account",
    emojiMatches: [],
    emojiIndex: 0,
    emojiStart: 0,
    voiceReady: false,
    forum: null,
    forumChannel: null,
    forumAt: 0,
    files: [],
    uploading: 0,
    pendingBanner: null,
  };

  /* ----------------------------------------------------------
     Helpers
     ---------------------------------------------------------- */

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function icon(name, cls) {
    return '<svg class="ico ' + (cls || "") + '" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  }

  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
    return (
      parts
        .map(function (p) {
          return p.charAt(0).toUpperCase();
        })
        .join("") || "?"
    );
  }

  function hueOf(value) {
    var hash = 0;
    var text = String(value || "");
    for (var i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
    return hash;
  }

  function decorOverlay(decor) {
    if (!decor || !decor.kind || decor.kind === "none") return "";

    var style = "--glow:" + esc(decor.color || "#5865f2") + ";--decor2:" + esc(decor.color2 || "#ffffff") + ";";
    var animated = decor.animated ? " is-animated" : "";

    if (decor.kind === "glow") {
      return '<span class="decor decor--glow' + animated + '" style="' + style + '" aria-hidden="true"></span>';
    }

    if (decor.kind === "horns") {
      return (
        '<span class="decor decor--horns' + animated + '" style="' + style + '" aria-hidden="true">' +
        '<svg viewBox="0 0 64 64"><path d="M17 27c-4-8-4-16-1-20 5 3 8 9 9 17z" fill="var(--decor2)" /><path d="M47 27c4-8 4-16 1-20-5 3-8 9-9 17z" fill="var(--decor2)" /></svg></span>'
      );
    }

    if (decor.kind === "wings") {
      return (
        '<span class="decor decor--wings' + animated + '" style="' + style + '" aria-hidden="true">' +
        '<svg viewBox="0 0 96 64"><path d="M44 30C33 10 18 4 4 8c2 13 12 24 26 28-9 2-16 0-22-5 6 12 18 19 31 17z" fill="var(--decor2)" /><path d="M52 30c11-20 26-26 40-22-2 13-12 24-26 28 9 2 16 0 22-5-6 12-18 19-31 17z" fill="var(--decor2)" /></svg></span>'
      );
    }

    if (decor.kind === "custom" && decor.url) {
      return '<span class="decor decor--custom' + animated + '" aria-hidden="true"><img src="' + esc(decor.url) + '" alt="" /></span>';
    }

    return "";
  }

  function avatar(person, cls) {
    var seed = (person && (person.sub || person.handle)) || "fleek";
    var hue = hueOf(seed);
    var style = "--a: hsl(" + hue + " 70% 52%); --b: hsl(" + ((hue + 52) % 360) + " 70% 48%);";
    var label = (person && (person.displayName || person.handle)) || "?";
    var dot = person && person.online === false ? "offline" : "online";
    var presence = (person && person.presence) || dot;
    var inner;

    if (person && person.avatarUrl) {
      inner =
        '<span class="av ' + (cls || "") + '" data-status="' + dot + '" data-presence="' + esc(presence) + '" style="' + style + '">' +
        '<img class="av-img" src="' + esc(person.avatarUrl) + '" alt="" loading="lazy" referrerpolicy="no-referrer" />' +
        "</span>";
    } else {
      inner =
        '<span class="av ' + (cls || "") + '" data-status="' + dot + '" data-presence="' + esc(presence) + '" style="' + style + '">' +
        esc(initials(label)) +
        "</span>";
    }

    var decor = decorOverlay(person && person.decor);
    if (!decor) return inner;

    return '<span class="av-wrap' + (cls ? " av-wrap--" + cls.replace("av--", "") : "") + '">' + inner + decor + "</span>";
  }

  function timeOf(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function dayOf(ts) {
    var d = new Date(ts);
    var today = new Date();
    var yesterday = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many || one + "s");
  }

  function channelIcon(type) {
    return { voice: "volume", forum: "forum", announcement: "megaphone", rules: "book" }[type] || "hash";
  }

  function channelById(id) {
    var servers = (S.data && S.data.servers) || [];
    for (var i = 0; i < servers.length; i += 1) {
      var hit = servers[i].channels.filter(function (c) { return c.id === id; })[0];
      if (hit) return hit;
    }
    return null;
  }

  function defaultChannelOf(server) {
    var channels = (server && server.channels) || [];
    var text = channels.filter(function (c) { return (c.type || "text") === "text"; })[0];
    return text || channels[0] || null;
  }

  /* ----------------------------------------------------------
     Theme
     ---------------------------------------------------------- */

  function applyTheme(theme) {
    var known = THEMES.some(function (t) {
      return t.id === theme;
    });
    var id = known ? theme : "dark";
    document.documentElement.setAttribute("data-theme", id);
    localStorage.setItem("fleek:theme:v3", id);
    S.theme = id;

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", id === "light" ? "#ffffff" : id === "midnight" ? "#000000" : "#313338");
  }

  function themeLabel(id) {
    var match = THEMES.filter(function (t) {
      return t.id === id;
    })[0];
    return match ? match.label : "Dark";
  }

  /* ----------------------------------------------------------
     API
     ---------------------------------------------------------- */

  function api(path, options) {
    var opts = options || {};
    var headers = {};
    if (opts.body) headers["Content-Type"] = "application/json";

    return fetch(path, {
      method: opts.method || "GET",
      credentials: "same-origin",
      headers: headers,
      body: opts.body,
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!res.ok) {
            if (res.status === 401 && path.indexOf("/api/auth/") !== 0) { if (path === "/api/session") showLanding(); else showAuth(); }
            var error = new Error(data.error || "Something went wrong.");
            error.status = res.status;
            throw error;
          }
          return data;
        });
    });
  }

  /* ----------------------------------------------------------
     Screen switching
     ---------------------------------------------------------- */

  /* The splash fades out once the app or the sign-in screen is ready. */
  function dismissBoot() {
    var boot = $("#boot");
    if (!boot || boot.dataset.closing === "1") return;
    boot.dataset.closing = "1";
    setTimeout(function () {
      boot.classList.add("is-done");
      setTimeout(function () {
        boot.hidden = true;
      }, 520);
    }, 260);
  }

  function showLanding() {
    window.__fleekBooted = true;
    clearInterval(S.timer);
    dismissBoot();
    $("#app").hidden = true;
    $("#auth").hidden = true;
    var landing = $("#landing");
    if (landing) landing.hidden = false;
    var progressEl = $("#landingProgress");
    var topEl = $("#landingTop");
    if (progressEl) progressEl.hidden = false;
    if (topEl) topEl.hidden = false;
    closeOverlay();
  }

  function hideLanding() {
    var landing = $("#landing");
    if (landing) landing.hidden = true;
    var progressEl = $("#landingProgress");
    var topEl = $("#landingTop");
    if (progressEl) progressEl.hidden = true;
    if (topEl) topEl.hidden = true;
  }

  function bindLanding() {
    document.querySelectorAll("[data-landing]").forEach(function (button) {
      button.addEventListener("click", function () {
        var action = button.getAttribute("data-landing");
        if (action === "install") {
          if (window.__fleekInstallPrompt) {
            window.__fleekInstallPrompt.prompt();
            window.__fleekInstallPrompt = null;
            return;
          }
          toast("Open your browser menu and choose Install app / Add to Home Screen.");
          return;
        }
        if (S.session) { location.href = "/"; return; }
        if (action === "open") action = "signup";
        hideLanding();
        showAuth();
        setAuthMode(action === "signup" ? "signup" : "login");
      });
    });
    window.addEventListener("beforeinstallprompt", function (event) {
      event.preventDefault();
      window.__fleekInstallPrompt = event;
    });

    var landing = document.getElementById("landing");
    if (!landing) return;

    var mock = landing.querySelector("#lpWindow");
    var mockTabs = Array.prototype.slice.call(landing.querySelectorAll("[data-lp-view]"));
    function setLpView(view) {
      if (!mock) return;
      mockTabs.forEach(function (tab) { tab.classList.toggle("is-active", tab.getAttribute("data-lp-view") === view); });
      mock.querySelectorAll("[data-lp-panel]").forEach(function (panel) {
        var isTarget = panel.getAttribute("data-lp-panel") === view;
        panel.hidden = !isTarget;
        if (isTarget) {
          panel.classList.remove("is-entering");
          void panel.offsetWidth;
          panel.classList.add("is-entering");
        }
      });
    }
    mockTabs.forEach(function (tab) {
      tab.addEventListener("click", function () { setLpView(tab.getAttribute("data-lp-view")); });
    });

    var nav = landing.querySelector(".landing-nav");
    var links = Array.prototype.slice.call(landing.querySelectorAll('.landing-links a[href^="#"]'));
    var sections = links
      .map(function (link) { return document.querySelector(link.getAttribute("href")); })
      .filter(Boolean);

    links.forEach(function (link) {
      link.addEventListener("click", function (event) {
        var target = document.querySelector(link.getAttribute("href"));
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        if (history.replaceState) history.replaceState(null, "", link.getAttribute("href"));
      });
    });

    var progress = document.getElementById("landingProgress");
    var topBtn = document.getElementById("landingTop");
    if (topBtn) {
      topBtn.addEventListener("click", function () { landing.scrollTo({ top: 0, behavior: "smooth" }); });
    }

    function onScroll() {
      var top = landing.scrollTop || 0;
      if (nav) nav.classList.toggle("is-scrolled", top > 8);
      if (topBtn) topBtn.classList.toggle("is-visible", top > 140);
      if (progress) {
        var max = landing.scrollHeight - landing.clientHeight;
        var pct = max > 0 ? Math.min(100, (top / max) * 100) : 0;
        progress.style.width = pct + "%";
      }
    }
    landing.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("scroll", onScroll, true);
    window.requestAnimationFrame(onScroll);
    onScroll();

    if ("IntersectionObserver" in window) {
      var reveal = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            reveal.unobserve(entry.target);
          }
        });
      }, { threshold: 0.15 });
      landing.querySelectorAll(".landing-features article, .landing-desktop").forEach(function (el) { reveal.observe(el); });

      var spy = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          links.forEach(function (link) {
            link.classList.toggle("is-current", link.getAttribute("href") === "#" + entry.target.id);
          });
        });
      }, { rootMargin: "-45% 0px -50% 0px" });
      sections.forEach(function (section) { spy.observe(section); });
    } else {
      landing.querySelectorAll(".landing-features article, .landing-desktop").forEach(function (el) { el.classList.add("is-visible"); });
    }
  }

  function showAuth() {
    window.__fleekBooted = true;
    clearInterval(S.timer);
    S.data = null;
    S.session = null;
    S.messages = [];
    S.dm = null;
    dismissBoot();
    hideLanding();
    $("#app").hidden = true;
    $("#auth").hidden = false;
    closeOverlay();
    setAuthMode("login");
    var handle = $("#authHandle");
    if (handle) setTimeout(function () { handle.focus(); }, 30);
  }

  function toast(message) {
    var el = $("#toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () {
      el.hidden = true;
    }, 2600);
  }

  function openOverlay(html, options) {
    var overlay = $("#overlay");
    overlay.innerHTML = html;
    overlay.hidden = false;
    if (!options || !options.locked) overlay.dataset.dismissible = "1";
    else delete overlay.dataset.dismissible;
  }

  function closeOverlay() {
    var overlay = $("#overlay");
    overlay.hidden = true;
    overlay.innerHTML = "";
    delete overlay.dataset.dismissible;
  }

  /* ----------------------------------------------------------
     Auth
     ---------------------------------------------------------- */

  function setAuthMode(mode) {
    S.authMode = mode === "signup" ? "signup" : "login";
    var authCard = document.querySelector("#auth .auth-card");
    if (authCard) {
      authCard.classList.remove("is-switching");
      void authCard.offsetWidth;
      authCard.classList.add("is-switching");
    }
    var signup = S.authMode === "signup";

    document.querySelectorAll("[data-auth-tab]").forEach(function (tab) {
      var active = tab.dataset.authTab === S.authMode;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });

    var display = $("#displayField");
    if (display) display.hidden = !signup;

    var submit = $("#authSubmit");
    if (submit) submit.textContent = signup ? "Create account" : "Sign in";

    var password = $("#authPassword");
    if (password) password.setAttribute("autocomplete", signup ? "new-password" : "current-password");

    var error = $("#authError");
    if (error) error.hidden = true;
  }

  function bindAuth() {
    document.querySelectorAll("[data-auth-tab]").forEach(function (tab) {
      tab.addEventListener("click", function () {
        setAuthMode(tab.dataset.authTab);
      });
    });

    $("#authForm").addEventListener("submit", function (event) {
      event.preventDefault();

      var handle = $("#authHandle").value.trim().toLowerCase();
      var password = $("#authPassword").value;
      var displayName = $("#authDisplay").value.trim();
      var errorEl = $("#authError");
      var button = $("#authSubmit");

      errorEl.hidden = true;

      if (!/^[a-z0-9_]{2,24}$/.test(handle)) {
        errorEl.textContent = "Handles are 2–24 characters: letters, numbers and underscores.";
        errorEl.hidden = false;
        return;
      }
      if (password.length < 8) {
        errorEl.textContent = "Passwords need at least 8 characters.";
        errorEl.hidden = false;
        return;
      }

      button.disabled = true;
      var path = S.authMode === "signup" ? "/api/auth/signup" : "/api/auth/login";

      api(path, { method: "POST", body: JSON.stringify({ handle: handle, password: password, displayName: displayName }) })
        .then(function (result) {
          S.session = { profile: result.profile };
          $("#authForm").reset();
          return start();
        })
        .catch(function (error) {
          errorEl.textContent = error.message;
          errorEl.hidden = false;
        })
        .then(function () {
          button.disabled = false;
        });
    });
  }

  /* ----------------------------------------------------------
     Boot
     ---------------------------------------------------------- */

  function ensureMobileChrome() {
    var app = $("#app");
    if (app && !$(".mobile-back")) {
      var back = document.createElement("button");
      back.type = "button";
      back.className = "mobile-back";
      back.setAttribute("data-action", "mobile-back");
      back.setAttribute("aria-label", "Back to conversations");
      back.innerHTML = icon("arrow-left", "ico--sm");
      app.appendChild(back);
    }
    if (app && !$(".nav-scrim")) {
      var scrim = document.createElement("div");
      scrim.className = "nav-scrim";
      scrim.setAttribute("data-action", "toggle-nav");
      scrim.setAttribute("aria-hidden", "true");
      app.appendChild(scrim);
    }

    if (document.documentElement.dataset.mobileReady === "1") return;
    document.documentElement.dataset.mobileReady = "1";

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") $("#app").classList.remove("nav-open");
    });

    // Long-press a server, channel or member on a touch screen to open the
    // same menu a right-click gives you on desktop.
    var timer = null;
    var start = null;

    document.addEventListener(
      "pointerdown",
      function (event) {
        if (event.pointerType === "mouse") return;

        var target = event.target.closest && event.target.closest(".rail-server, .row, .member, .voice-person");
        if (!target) return;

        start = { x: event.clientX, y: event.clientY };
        timer = setTimeout(function () {
          timer = null;
          if (navigator.vibrate) navigator.vibrate(8);
          target.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: start.x,
              clientY: start.y,
            })
          );
        }, 480);
      },
      { passive: true }
    );

    ["pointermove", "pointerup", "pointercancel", "scroll"].forEach(function (type) {
      document.addEventListener(
        type,
        function (event) {
          if (!timer) return;
          if (type === "pointermove" && start && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 12) return;
          clearTimeout(timer);
          timer = null;
        },
        { passive: true }
      );
    });
  }

  var LANDING_ONLY = /^\/landing\/?$/i.test(location.pathname);

  function boot() {
    applyTheme(S.theme);
    bindAuth();
    bindLanding();

    if (LANDING_ONLY) {
      api("/api/session")
        .then(function (session) { S.session = session; showLanding(); })
        .catch(function () { showLanding(); });
      return;
    }

    // Render the landing immediately instead of holding the splash while the
    // session request is in flight; signed-in users are switched to the app
    // as soon as the session resolves.
    showLanding();

    api("/api/session")
      .then(function (session) {
        S.session = session;
        return start();
      })
      .catch(function (error) {
        if (error.status === 401) { showLanding(); return; }
        var fatal = $("#fatal");
        fatal.hidden = false;
        fatal.textContent = "Fleek couldn't start: " + error.message;
      });
  }

  function start() {
    window.__fleekBooted = true;
    dismissBoot();
    hideLanding();
    $("#auth").hidden = true;
    $("#app").hidden = false;
    ensureMobileChrome();
    if (S.mode !== "channel") $("#app").classList.remove("chat-open");

    if (window.FleekVoice && !S.voiceReady) {
      S.voiceReady = true;
      window.FleekVoice.init({ api: api, self: me, onUpdate: onVoiceUpdate });
    }

    return refreshState()
      .then(function () {
        var server = S.data.servers.filter(function (s) { return s.id === S.serverId; })[0] || S.data.servers[0];
        if (server) {
          S.serverId = server.id;
          S.mode = "channel";
          S.channelId = (defaultChannelOf(server) || {}).id || null;
        } else {
          S.mode = "home";
          S.serverId = null;
          S.channelId = null;
        }

        var deep = channelFromHash();
        if (deep) {
          S.mode = "channel";
          S.serverId = deep.server.id;
          S.channelId = deep.channel.id;
          S.dm = null;
        }

        renderRail();
        renderSidebar();
        renderMembers();
        renderMain();
        if (inviteFromPath()) {
          joinInvite(inviteFromPath());
          return;
        }
        if (S.mode === "channel" && S.channelId) {
          var live = activeChannel();
          if (live && live.type === "forum") return loadForum(live.id);
          if (live && (live.type === "voice" || live.type === "rules")) return;
          return loadMessages(S.channelId);
        }
      })
      .then(function () {
        startPolling();
      });
  }

  /* ----------------------------------------------------------
     State
     ---------------------------------------------------------- */

  function refreshState() {
    return api("/api/state").then(function (data) {
      S.data = data;
      S.stateAt = Date.now();
      renderRail();
      renderSidebar();
      renderMembers();
      if (S.mode === "home" || S.mode === "friends") renderMain();
      return data;
    });
  }

  var NAME_FONTS = {
    inter: "'Inter', system-ui, sans-serif",
    georgia: "Georgia, 'Times New Roman', serif",
    arialblack: "'Arial Black', Arial, sans-serif",
    verdana: "Verdana, Geneva, sans-serif",
    trebuchet: "'Trebuchet MS', sans-serif",
    courier: "'Courier New', monospace",
    impact: "Impact, 'Arial Black', sans-serif",
    comic: "'Comic Sans MS', 'Comic Sans', cursive",
    palatino: "'Palatino Linotype', Palatino, serif",
  };

  function nameStyle(person) {
    if (!person) return "";
    var css = "";
    if (person.nameFont && NAME_FONTS[person.nameFont]) css += "font-family:" + NAME_FONTS[person.nameFont] + ";";
    var c1 = person.nameColor1 || "";
    var c2 = person.nameColor2 || "";
    if (c1 && c2) {
      css += "background-image:linear-gradient(90deg," + c1 + "," + c2 + ");-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;";
    } else if (c1) {
      css += "color:" + c1 + ";";
    }
    if (person.nameGlow) css += "text-shadow:0 0 8px " + person.nameGlow + ";";
    return css;
  }

  function verifiedBadge() {
    return '<img class="verified-badge" src="assets/verified.png?v=50" alt="Verified" title="Verified" />';
  }

  function me() {
    return (S.data && S.data.me) || (S.session && S.session.profile) || { handle: "", displayName: "", sub: "" };
  }

  function activeServer() {
    if (!S.data) return null;
    return S.data.servers.filter(function (s) { return s.id === S.serverId; })[0] || null;
  }

  function activeChannel() {
    var server = activeServer();
    if (!server) return null;
    return server.channels.filter(function (c) { return c.id === S.channelId; })[0] || null;
  }

  function dmChannelFor(friend) {
    return "dm:" + [me().sub, friend.sub].sort().join("|");
  }

  /* ----------------------------------------------------------
     Rail
     ---------------------------------------------------------- */

  function renderRail() {
    var pending = S.data ? S.data.incoming.length : 0;

    var servers = S.data
      ? S.data.servers
          .map(function (server) {
            var active = S.mode === "channel" && !S.dm && server.id === S.serverId;
            return (
              '<button class="rail-btn rail-server ' + (active ? "is-active" : "") + '" data-action="open-server" data-server="' + esc(server.id) + '" title="' + esc(server.name) + '" aria-label="' + esc(server.name) + '">' +
              (server.iconUrl
                ? '<img class="rail-icon" src="' + esc(server.iconUrl) + '" alt="" loading="lazy" />'
                : esc(initials(server.name))) +
              (server.verified ? '<span class="rail-verified"><img src="assets/verified.png?v=50" alt="Verified" /></span>' : "") +
              "</button>"
            );
          })
          .join("")
      : "";

    $("#rail").innerHTML =
      '<div class="rail-top">' +
      '<div class="rail-logo" aria-hidden="true"><img class="rail-mark" src="assets/fleek.png?v=50" alt="" /></div>' +
      '<button class="rail-btn ' + (S.mode === "home" ? "is-active" : "") + '" data-action="home" aria-label="Friends and DMs" title="Home">' +
      icon("home") +
      "</button>" +
      '<button class="rail-btn ' + (S.mode === "friends" ? "is-active" : "") + '" data-action="open-friends" aria-label="Friends" title="Friends">' +
      icon("users") +
      (pending ? '<span class="badge">' + pending + "</span>" : "") +
      "</button>" +
      '<div class="rail-sep"></div>' +
      servers +
      '<button class="rail-btn rail-add" data-action="add-server" aria-label="Create or join a server" title="Create a server">' +
      icon("plus") +
      "</button>" +
      "</div>" +
      "";
  }

  /* ----------------------------------------------------------
     Sidebar
     ---------------------------------------------------------- */

  function voicePeopleHTML(channel) {
    var snap = window.FleekVoice ? window.FleekVoice.snapshot() : null;
    var people = channel.voice || [];
    if (snap && snap.joined && snap.channelId === channel.id) people = snap.participants || [];
    if (!people.length) return "";

    return (
      '<div class="voice-people">' +
      people
        .map(function (person) {
          return (
            '<button class="voice-person' + (snap && snap.speaking && snap.speaking[person.sub] ? " is-speaking" : "") + '" data-action="profile" data-sub="' + esc(person.sub) + '">' +
            avatar(person, "av--xs") +
            '<span class="voice-person-name">' + esc(person.displayName) + (person.verified ? verifiedBadge() : "") + "</span>" +
            (person.muted ? icon("mic-off", "ico--xs") : "") +
            (person.sharing ? icon("screen", "ico--xs") : "") +
            "</button>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function renderSidebar() {
    if (!S.data) return;
    var self = me();
    var server = activeServer();
    var body = "";

    if (S.mode === "channel" && server) {
      var groups = [];
      var groupIndex = {};

      server.channels.forEach(function (channel) {
        var label = channel.category || ((channel.type || "text") === "voice" ? "Voice channels" : "Channels");
        if (!groupIndex[label]) {
          groupIndex[label] = { label: label, channels: [] };
          groups.push(groupIndex[label]);
        }
        groupIndex[label].channels.push(channel);
      });

      function channelRow(channel) {
        var active = !S.dm && channel.id === S.channelId;
        return (
          '<button class="row row--' + esc(channel.type || "text") + (active ? " is-active" : "") + '" data-action="open-channel" data-channel="' + esc(channel.id) + '">' +
          icon(channelIcon(channel.type)) +
          '<span class="row-name">' + esc(channel.name) + "</span>" +
          (channel.type === "rules" ? '<span class="row-tag">read-only</span>' : "") +
          "</button>" +
          (channel.type === "voice" ? voicePeopleHTML(channel) : "")
        );
      }

      var channelGroups = groups.length
        ? groups
            .map(function (group) {
              return (
                '<div class="side-group"><div class="side-label">' + esc(group.label) + "</div>" +
                group.channels.map(channelRow).join("") +
                "</div>"
              );
            })
            .join("")
        : '<p class="empty-hint">No channels yet. Make the first one.</p>';

      body =
        '<div class="side-head"><div>' +
        '<div class="side-title">' + esc(server.name) + (server.verified ? verifiedBadge() : "") + "</div>" +
        '<div class="side-sub">' + plural(server.members.length, "member") + "</div>" +
        "</div>" +
        '<button class="icon-btn" data-action="add-channel" aria-label="Create channel" title="Create channel">' +
        icon("plus") +
        "</button></div>" +
        '<div class="side-scroll">' +
        channelGroups +
        "</div>" +
        '<div class="side-invite"><button class="btn btn--sm btn--primary" data-action="invite">Invite people</button></div>';
    } else {
      var dms = S.data.friends.length
        ? S.data.friends
            .map(function (friend) {
              var active = S.dm && S.dm.sub === friend.sub;
              return (
                '<button class="row ' + (active ? "is-active" : "") + '" data-action="dm" data-sub="' + esc(friend.sub) + '">' +
                avatar(friend, "av--xs") +
                '<span class="row-name">' + esc(friend.displayName) + "</span>" +
                "</button>"
              );
            })
            .join("")
        : '<p class="empty-hint">No friends yet. Add someone by handle.</p>';

      body =
        '<div class="side-head side-head--home"><div class="home-search-wrap">' +
        icon("search", "ico--sm") +
        '<input id="homeSearch" placeholder="Find or start a conversation" aria-label="Find or start a conversation" autocomplete="off" />' +
        "</div></div>" +
        '<div class="side-scroll">' +
        '<button class="row home-friends' + (S.mode === "friends" ? " is-active" : "") + '" data-action="open-friends">' +
        icon("users", "ico--sm") +
        '<span class="row-name">Friends</span>' +
        (S.data.incoming.length ? '<span class="row-count">' + S.data.incoming.length + "</span>" : "") +
        "</button>" +
        '<div class="side-group"><div class="side-label">Direct messages <button data-action="add-friend" aria-label="Add a friend">' +
        icon("plus", "ico--sm") +
        "</button></div>" + dms + "</div>" +
        '<div class="side-group"><div class="side-label">Servers</div>' +
        (S.data.servers.length
          ? S.data.servers
              .map(function (item) {
                return '<button class="row" data-action="open-server" data-server="' + esc(item.id) + '">' +
                  '<span class="server-dot"></span><span class="row-name">' + esc(item.name) + "</span></button>";
              })
              .join("")
          : '<p class="empty-hint">No servers yet. Create one, or join with an invite code.</p>') +
        '<button class="row" data-action="add-server"><span class="server-dot"></span><span class="row-name">Create a server</span></button>' +
        "</div></div>";
    }

    $("#sidebar").innerHTML =
      body +
      '<div class="side-foot">' +
      '<button class="avatar-btn" data-action="member" data-sub="' + esc(self.sub) + '" aria-label="Your profile">' +
      avatar(self, "av--sm") +
      "</button>" +
      '<button type="button" class="who" data-action="user-menu" aria-label="Your account">' +
      '<span class="who-name">' + esc(self.displayName) + (me().verified ? verifiedBadge() : '') + '</span>' +
      '<span class="who-handle">@' + esc(self.handle) + "</span>" +
      (self.statusText ? '<span class="who-status">' + esc(self.statusText) + "</span>" : "") +
      "</button>" +
      '<button class="icon-btn desk-only" data-action="open-settings" aria-label="Settings" title="Settings">' + icon("gear") + "</button>" +
      "</div>";

    bindHomeSearch();
  }

  function bindHomeSearch() {
    var search = $("#homeSearch");
    if (!search) return;

    search.addEventListener("keydown", function (event) {
      if (event.key !== "Enter") return;

      var query = search.value.trim().replace(/^@/, "").toLowerCase();
      if (!query) return;

      var match = (S.data.friends || []).filter(function (friend) {
        return friend.handle.toLowerCase() === query || friend.displayName.toLowerCase().indexOf(query) !== -1;
      })[0];

      search.value = "";
      if (match) return openDm(match);
      openAddFriend(query);
    });
  }

  /* ----------------------------------------------------------
     Members
     ---------------------------------------------------------- */

  function renderMembers() {
    if (!S.data) return;
    var server = activeServer();
    var inServer = S.mode === "channel" && server && !S.dm;
    var list = inServer ? server.members : S.data.friends || [];

    var online = list.filter(function (m) { return m.online; });
    var offline = list.filter(function (m) { return !m.online; });

    function group(title, entries) {
      if (!entries.length) return "";
      return (
        '<div class="member-group"><div class="member-group-title">' + title + " — " + entries.length + "</div>" +
        entries
          .map(function (member) {
            return (
              '<button class="member" data-action="member" data-sub="' + esc(member.sub) + '" data-handle="' + esc(member.handle) + '">' +
              avatar(member, "av--sm") +
              '<span class="member-name" style="' + nameStyle(member) + '">' + esc(member.displayName) + (member.verified ? verifiedBadge() : "") + "</span>" +
              (member.statusText ? '<span class="member-status" title="' + esc(member.statusText) + '">' + esc(member.statusText) + "</span>" : "") +
              (member.isMe || member.sub === me().sub ? '<span class="member-flag">you</span>' : "") +
              "</button>"
            );
          })
          .join("") +
        "</div>"
      );
    }

    $("#members").innerHTML =
      '<div class="members-head"><span>' + (inServer ? "Members" : "Friends") + "</span><span>" + online.length + " online</span></div>" +
      '<div class="members-scroll">' +
      (list.length
        ? group("Online", online) + group("Offline", offline)
        : '<p class="empty-hint">' + (inServer ? "No members yet." : "No friends yet. Add someone by handle.") + "</p>") +
      "</div>";
  }

  /* ----------------------------------------------------------
     Main
     ---------------------------------------------------------- */

  function renderMain() {
    var main = $("#main");
    if (!S.data) return;

    if (S.mode === "home") {
      main.innerHTML = homeHTML();
      return;
    }

    if (S.mode === "friends") {
      main.innerHTML = friendsHTML();
      bindFriendsPage();
      return;
    }

    var server = activeServer();
    var channel = activeChannel();

    if (!S.dm && channel) {
      if (channel.type === "voice") return renderVoice(channel);
      if (channel.type === "forum") return renderForum(channel);
      if (channel.type === "rules") return renderRules(channel);
    }

    if (!S.dm && (!server || !channel)) {
      main.innerHTML =
        '<div class="main-head"><button class="icon-btn mobile-nav" data-action="toggle-nav" aria-label="Channels">' + icon("menu") + "</button>" +
        '<div><span class="main-title">No channel</span></div></div>' +
        '<div class="welcome"><h2>Make a channel</h2><p>Servers need at least one text channel to talk in.</p>' +
        '<button class="btn btn--primary" data-action="add-channel">' + icon("plus", "ico--sm") + " Create channel</button></div>";
      return;
    }

    var title = S.dm
      ? '<span class="main-title">' + esc(S.dm.displayName) + '</span><span class="main-sub">@' + esc(S.dm.handle) + "</span>"
      : '<span class="main-title">' + esc(channel.name) + '</span><span class="main-sub">' + esc(channel.topic || "") + "</span>";

    main.innerHTML =
      '<div class="main-head">' +
      '<button class="icon-btn mobile-back-inline" data-action="mobile-back" aria-label="Back">' + icon("arrow-left") + "</button>" +
      (S.dm ? avatar(S.dm, "av--sm") : icon(channelIcon(channel.type))) +
      '<div style="min-width:0">' + title + "</div>" +
      '<div class="main-head-right">' +
      (S.dm ? "" : '<button class="icon-btn" data-action="invite" aria-label="Invite people" title="Invite people">' + icon("users") + "</button>") +
      "</div></div>" +
      '<div class="feed" id="feed"></div>' +
      composerHTML(channel);

    renderFeed(true);
    bindComposer();
  }

  function composerHTML(channel) {
    var server = activeServer();

    if (channel && channel.isLogs) {
      return (
        '<div class="composer-wrap"><div class="read-only-note">' +
        icon("book", "ico--sm") +
        "<span>Fleek writes server activity here — joins, deleted messages, renames, roles and webhooks.</span></div></div>"
      );
    }

    var readOnly = !S.dm && channel && channel.type === "announcement" && !(server && server.isOwner);

    if (readOnly) {
      return (
        '<div class="composer-wrap"><div class="read-only-note">' +
        icon("megaphone", "ico--sm") +
        "<span>Only the server owner can post announcements. Everyone can read them.</span></div></div>"
      );
    }

    return (        '<div class="composer-wrap"><div class="composer" id="composer">' +
      '<div class="compose-files" id="composeFiles" hidden></div>' +
      '<div class="composer-row">' +
      '<textarea id="composerInput" rows="1" maxlength="2000" placeholder="Message ' +
      esc(S.dm ? "@" + S.dm.handle : "#" + channel.name) +
      '" aria-label="Message"></textarea>' +
      '<div class="composer-actions">' +
      '<button class="icon-btn fmt-attach" data-action="attach" aria-label="Attach a file" title="Attach a file">' +
      icon("paperclip") +
      "</button>" +
      '<button class="send-btn" id="sendBtn" data-action="send" aria-label="Send">' +
      icon("send", "ico--sm") +
      "</button></div></div>" +
      '<div class="composer-toolbar">' +
      '<button type="button" class="fmt-btn" data-action="format" data-fmt="bold" title="Bold (Ctrl+B)"><b>B</b></button>' +
      '<button type="button" class="fmt-btn" data-action="format" data-fmt="italic" title="Italic (Ctrl+I)"><i>I</i></button>' +
      '<button type="button" class="fmt-btn" data-action="format" data-fmt="strike" title="Strikethrough"><s>S</s></button>' +
      '<button type="button" class="fmt-btn" data-action="format" data-fmt="code" title="Inline code"><code>&lt;/&gt;</code></button>' +
      '<button type="button" class="fmt-btn" data-action="format" data-fmt="spoiler" title="Spoiler">||</button>' +
      '<button type="button" class="fmt-btn" data-action="format" data-fmt="quote" title="Quote">&gt;</button>' +
      "</div>" +
      '<div class="emoji-pop" id="emojiPop" hidden></div>' +
      "</div>" +
      '<p class="composer-hint">Enter to send · Shift + Enter for a new line · Markdown, pasted images and files</p>' +
      '<input type="file" id="attachFile" multiple hidden />' +
      "</div>"
    );
  }

  function homeHTML() {
    var d = S.data;

    var incoming = d.incoming.length
      ? d.incoming
          .map(function (person) {
            return (
              '<div class="person">' + avatar(person, "av--sm") +
              '<div class="person-info"><div class="person-name">' + esc(person.displayName) +
              '</div><div class="person-handle">@' + esc(person.handle) + "</div></div>" +
              '<div class="person-actions">' +
              '<button class="btn btn--sm btn--primary" data-action="accept-friend" data-handle="' + esc(person.handle) + '">Accept</button>' +
              '<button class="btn btn--sm btn--ghost" data-action="decline-friend" data-handle="' + esc(person.handle) + '">Decline</button>' +
              "</div></div>"
            );
          })
          .join("")
      : '<p class="muted">No pending requests.</p>';

    var friends = d.friends.length
      ? d.friends
          .map(function (friend) {
            return (
              '<div class="person">' + avatar(friend, "av--sm") +
              '<div class="person-info"><div class="person-name">' + esc(friend.displayName) +
              '</div><div class="person-handle">@' + esc(friend.handle) + (friend.online ? " · online" : "") + "</div></div>" +
              '<div class="person-actions">' +
              '<button class="btn btn--sm" data-action="dm" data-sub="' + esc(friend.sub) + '">Message</button>' +
              '<button class="icon-btn" data-action="remove-friend" data-handle="' + esc(friend.handle) + '" aria-label="Remove friend">' +
              icon("x", "ico--sm") +
              "</button></div></div>"
            );
          })
          .join("")
      : '<p class="muted">No friends yet. Add someone by their handle to start a DM.</p>';

    var servers = d.servers.length
      ? d.servers
          .map(function (server) {
            return (
              '<div class="person">' +
              (server.iconUrl
                ? '<img class="server-icon server-icon--img" src="' + esc(server.iconUrl) + '" alt="" />'
                : '<span class="server-icon">' + esc(initials(server.name)) + "</span>") +
              '<div class="person-info"><div class="person-name">' + esc(server.name) +
              '</div><div class="person-handle">' + plural(server.members.length, "member") + " · " + plural(server.channels.length, "channel") + "</div></div>" +
              '<div class="person-actions"><button class="btn btn--sm" data-action="open-server" data-server="' + esc(server.id) + '">Open</button></div></div>'
            );
          })
          .join("")
      : '<p class="muted">You are not in any servers yet.</p>';

    return (
      '<div class="main-head"><button class="icon-btn mobile-nav" data-action="toggle-nav" aria-label="Sidebar">' + icon("menu") +
      '</button><div><span class="main-title">Home</span><span class="main-sub">Friends, DMs and servers</span></div>' +
      '<div class="main-head-right"><button class="btn btn--sm btn--primary" data-action="add-server">' + icon("plus", "ico--sm") + " New server</button></div></div>" +
      '<div class="friends">' +
      '<div class="friends-card"><h3>Your servers — ' + d.servers.length + "</h3>" + servers +
      '<button class="btn btn--sm" data-action="add-server">' + icon("plus", "ico--sm") + " Create or join a server</button></div>" +
      '<div class="friends-card"><h3>Requests — ' + d.incoming.length + "</h3>" + incoming + "</div>" +
      '<div class="friends-card"><h3>Friends — ' + d.friends.length + "</h3>" + friends + "</div>" +
      '<div class="friends-card"><h3>Find someone</h3>' +
      '<p class="muted">Everyone picked a handle. Search it, send a request, then DM.</p>' +
      '<button class="btn btn--primary" data-action="add-friend">' + icon("plus", "ico--sm") + " Add a friend</button></div>" +
      "</div>"
    );
  }

  function friendsHTML() {
    var d = S.data;
    var tab = S.friendsTab || "all";

    var tabs =
      '<div class="friends-tabs">' +
      '<span class="friends-title">' + icon("users", "ico--sm") + " Friends</span>" +
      '<span class="friends-divider"></span>' +
      '<button class="friends-tab' + (tab === "all" ? " is-active" : "") + '" data-action="friends-tab" data-tab="all">All</button>' +
      '<button class="friends-tab' + (tab === "pending" ? " is-active" : "") + '" data-action="friends-tab" data-tab="pending">Pending' +
      (d.incoming.length ? '<span class="friends-count">' + d.incoming.length + "</span>" : "") +
      "</button>" +
      '<button class="friends-add' + (tab === "add" ? " is-active" : "") + '" data-action="friends-tab" data-tab="add">Add Friend</button>' +
      "</div>";

    var body = "";

    if (tab === "pending") {
      var incoming = (d.incoming || [])
        .map(function (person) {
          return (
            '<div class="friend-row">' + avatar(person, "av--sm") +
            '<div class="friend-id"><span class="friend-name">' + esc(person.displayName) +
            '</span><span class="friend-handle">@' + esc(person.handle) + '</span></div>' +
            '<span class="friend-note">Incoming</span>' +
            '<div class="friend-actions">' +
            '<button class="btn btn--sm btn--primary" data-action="accept-friend" data-handle="' + esc(person.handle) + '">Accept</button>' +
            '<button class="btn btn--sm btn--ghost" data-action="decline-friend" data-handle="' + esc(person.handle) + '">Decline</button>' +
            "</div></div>"
          );
        })
        .join("");

      var outgoing = (d.outgoing || [])
        .map(function (person) {
          return (
            '<div class="friend-row">' + avatar(person, "av--sm") +
            '<div class="friend-id"><span class="friend-name">' + esc(person.displayName) +
            '</span><span class="friend-handle">@' + esc(person.handle) + '</span></div>' +
            '<span class="friend-note">Outgoing</span>' +
            '<div class="friend-actions"><button class="btn btn--sm btn--ghost" data-action="decline-friend" data-handle="' + esc(person.handle) + '">Cancel</button></div></div>'
          );
        })
        .join("");

      body = incoming || outgoing
        ? '<div class="friends-list">' + incoming + outgoing + "</div>"
        : '<div class="friends-empty"><h2>No pending requests</h2><p>Requests you send and receive show up here.</p></div>';
    } else if (tab === "add") {
      body =
        '<div class="friends-add-wrap"><h2>Add a friend</h2>' +
        '<p class="friends-lead">Search by handle. You can send a request, then message each other once it is accepted.</p>' +
        '<div class="prefix friends-search"><span>@</span><input id="friendsSearch" autocomplete="off" spellcheck="false" placeholder="someones_handle" /></div>' +
        '<div class="search-results" id="friendResults"><p class="muted">Search by handle to add someone.</p></div></div>';
    } else {
      body = (d.friends || []).length
        ? '<div class="friends-list">' +
          d.friends
            .map(function (person) {
              return (
                '<div class="friend-row">' + avatar(person, "av--sm") +
                '<div class="friend-id"><span class="friend-name">' + esc(person.displayName) +
                '</span><span class="friend-handle">@' + esc(person.handle) +
                (person.statusText ? " · " + esc(person.statusText) : person.online ? " · online" : "") + "</span></div>" +
                '<div class="friend-actions">' +
                '<button class="btn btn--sm" data-action="dm" data-sub="' + esc(person.sub) + '">Message</button>' +
                '<button class="icon-btn" data-action="remove-friend" data-handle="' + esc(person.handle) + '" aria-label="Remove friend">' +
                icon("x", "ico--sm") +
                "</button></div></div>"
              );
            })
            .join("") +
          "</div>"
        : '<div class="friends-empty"><h2>No friends yet</h2><p>Use Add Friend to search a handle and send a request.</p>' +
          '<button class="btn btn--primary" data-action="friends-tab" data-tab="add">Add Friend</button></div>';
    }

    return (
      '<div class="main-head friends-head">' +
      '<button class="icon-btn mobile-back-inline" data-action="mobile-back" aria-label="Back">' + icon("arrow-left") + "</button>" +
      '<div class="friends-tabs-wrap">' + tabs + "</div></div>" +
      '<div class="friends-view">' + body + "</div>"
    );
  }

  function bindFriendsPage() {
    var search = $("#friendsSearch");
    if (!search) return;

    search.focus();

    var timer;
    search.addEventListener("input", function () {
      clearTimeout(timer);
      var query = search.value.trim().replace(/^@/, "");

      var box = $("#friendResults");
      if (!query) {
        box.innerHTML = '<p class="muted">Search by handle to add someone.</p>';
        return;
      }

      timer = setTimeout(function () {
        searchPeople(query);
      }, 220);
    });
  }

  function openFriends(tab) {
    if (window.matchMedia("(max-width: 820px)").matches) return openHome();

    S.mode = "friends";
    S.friendsTab = tab || "all";
    S.dm = null;
    S.serverId = null;
    S.channelId = null;
    $("#app").classList.remove("nav-open");
    $("#app").classList.remove("chat-open");
    renderRail();
    renderSidebar();
    renderMembers();
    renderMain();
  }

  /* ----------------------------------------------------------
     Feed
     ---------------------------------------------------------- */

  function renderFeed(scrollToBottom) {
    var feed = $("#feed");
    if (!feed) return;

    if (!S.messages.length) {
      feed.innerHTML =
        '<div class="feed-empty"><strong>' +
        (S.dm ? "No messages with @" + esc(S.dm.handle) + " yet" : "This channel is empty") +
        "</strong><span>" +
        (S.dm ? "You're friends — say something to start the conversation." : "No messages yet. Yours would be the first.") +
        "</span></div>";
      return;
    }

    var nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
    var html = "";
    var previous = null;
    var lastDay = "";

    S.messages.forEach(function (message) {
      var day = dayOf(message.createdAt);
      if (day !== lastDay) {
        html += '<div class="msg-stamp" style="padding:14px 4px 6px">' + esc(day) + "</div>";
        lastDay = day;
        previous = null;
      }
      html += messageHTML(message, previous);
      previous = message;
    });

    feed.innerHTML = html;

    if (window.FleekEmoji && window.FleekEmoji.twemoji) window.FleekEmoji.twemoji(feed);
    if (scrollToBottom || nearBottom) feed.scrollTop = feed.scrollHeight;
  }

  function embedsHTML(embeds) {
    if (!embeds || !embeds.length) return "";

    return (
      '<div class="embeds">' +
      embeds
        .map(function (embed) {
          var color = "#" + ("000000" + (Number(embed.color) || 0x5865f2).toString(16)).slice(-6);
          return (
            '<div class="embed" style="--embed:' + color + '">' +
            (embed.title ? '<div class="embed-title">' + esc(embed.title) + "</div>" : "") +
            (embed.description ? '<div class="embed-desc">' + esc(embed.description) + "</div>" : "") +
            "</div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function messageHTML(message, previous) {
    var kind = message.kind || "user";
    var embeds = message.embeds || [];
    var canDelete = kind === "user" && !!message.author && message.author.sub === me().sub;
    var tag = kind === "webhook" ? '<span class="msg-tag">webhook</span>' : kind === "log" ? '<span class="msg-tag">log</span>' : "";

    var grouped =
      kind === "user" &&
      previous &&
      (previous.kind || "user") === "user" &&
      previous.author.sub === message.author.sub &&
      message.createdAt - previous.createdAt < 5 * 60 * 1000;

    var body = window.FleekMarkdown
      ? window.FleekMarkdown.render(message.body, {})
      : "<p>" + esc(message.body) + "</p>";

    return (
      '<div class="msg ' + (grouped ? "is-grouped" : "") + '" data-mid="' + esc(message.id) + '">' +
      '<div class="msg-gutter">' +
      (grouped
        ? '<span class="msg-time-gutter">' + esc(timeOf(message.createdAt)) + "</span>"
        : '<button type="button" class="msg-avatar" data-action="profile" data-sub="' +
          esc(message.author.sub) +
          '" aria-label="' +
          esc(message.author.displayName) +
          '">' +
          avatar(message.author, "av--sm") +
          "</button>") +
      "</div>" +
      '<div class="msg-main">' +
      (grouped
        ? ""
        : '<div class="msg-head"><button type="button" class="msg-author" style="' + nameStyle(message.author) + '" data-action="profile" data-sub="' +
          esc(message.author.sub) +
          '">' +
          esc(message.author.displayName) +
          (message.author.verified ? verifiedBadge() : "") +
          "</button>" +
          tag +
          '<span class="msg-stamp">' +
          esc(timeOf(message.createdAt)) +
          "</span></div>") +
      '<div class="msg-body">' + body + embedsHTML(embeds) + filesHTML(message.files) + "</div>" +
      (canDelete
        ? '<button type="button" class="msg-del" data-action="delete-message" data-id="' +
          esc(message.id) +
          '" aria-label="Delete your message" title="Delete your message">' +
          icon("x", "ico--xs") +
          "</button>"
        : "") +
      "</div></div>"
    );
  }

  function loadMessages(channel) {
    S.channelId = channel;
    S.lastTs = 0;
    S.messages = [];

    var feed = $("#feed");
    if (feed) feed.innerHTML = '<div class="feed-empty"><span>Loading messages…</span></div>';

    return api("/api/messages?channel=" + encodeURIComponent(channel)).then(function (result) {
      if (result.channel !== S.channelId) return;
      S.messages = result.messages;
      S.lastTs = result.messages.length ? result.messages[result.messages.length - 1].createdAt : 0;
      renderFeed(true);
    });
  }

  function pollMessages() {
    if (!S.data || S.mode !== "channel" || !S.channelId || document.hidden) return;

    var live = activeChannel();
    if (!S.dm && live && live.type !== "text" && live.type !== "announcement") return;

    api("/api/messages?channel=" + encodeURIComponent(S.channelId) + "&after=" + S.lastTs)
      .then(function (result) {
        if (result.channel !== S.channelId || !result.messages.length) return;
        var known = {};
        S.messages.forEach(function (m) {
          known[m.id] = true;
        });
        var added = 0;
        result.messages.forEach(function (message) {
          if (!known[message.id]) {
            S.messages.push(message);
            added += 1;
          }
        });
        if (!added) return;
        S.lastTs = S.messages[S.messages.length - 1].createdAt;
        renderFeed(false);
      })
      .catch(function () {});
  }

  function startPolling() {
    clearInterval(S.timer);
    S.timer = setInterval(function () {
      pollMessages();
      pollForum();
      if (Date.now() - S.stateAt > 20000) refreshState().catch(function () {});
    }, 4000);

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) pollMessages();
    });
  }

  /* ----------------------------------------------------------
     Composer
     ---------------------------------------------------------- */

  function bindComposer() {
    var input = $("#composerInput");
    if (!input) return;

    autosize(input);
    input.focus();

    input.addEventListener("input", function () {
      autosize(input);
      updateEmojiPop();
    });

    input.addEventListener("keydown", function (event) {
      var pop = $("#emojiPop");
      var popOpen = pop && !pop.hidden;

      if (popOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        var count = S.emojiMatches.length;
        S.emojiIndex = (S.emojiIndex + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
        paintEmojiPop();
        return;
      }
      if (popOpen && (event.key === "Enter" || event.key === "Tab")) {
        event.preventDefault();
        var match = S.emojiMatches[S.emojiIndex];
        if (match) applyEmoji(match.name);
        return;
      }
      if (popOpen && event.key === "Escape") {
        event.preventDefault();
        pop.hidden = true;
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
      }
    });

    input.addEventListener("keydown", function (event) {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey) return;
      var key = String(event.key || "").toLowerCase();
      if (key === "b") {
        event.preventDefault();
        applyFormat("bold");
      } else if (key === "i") {
        event.preventDefault();
        applyFormat("italic");
      }
    });

    var fileInput = $("#attachFile");
    if (fileInput) {
      fileInput.addEventListener("change", function () {
        pickFiles(fileInput.files);
        fileInput.value = "";
      });
    }

    input.addEventListener("paste", function (event) {
      var clip = event.clipboardData;
      if (!clip) return;

      var pasted = [];
      if (clip.files && clip.files.length) {
        pasted = Array.prototype.slice.call(clip.files);
      } else if (clip.items && clip.items.length) {
        Array.prototype.forEach.call(clip.items, function (item) {
          if (item.kind !== "file") return;
          var file = item.getAsFile();
          if (file) pasted.push(file);
        });
      }

      if (!pasted.length) return;
      event.preventDefault();

      pasted = pasted.map(function (file) {
        if (file.name) return file;
        var ext = (file.type && file.type.split("/")[1]) || "png";
        return new File([file], "pasted-" + Date.now() + "." + ext, { type: file.type || "image/png" });
      });

      pickFiles(pasted);
      toast(pasted.length === 1 ? "Image pasted — press Enter to send." : pasted.length + " files pasted — press Enter to send.");
    });

    renderComposeFiles();
  }

  /* ----------------------------------------------------------
     Formatting + attachments
     ---------------------------------------------------------- */

  var FORMATS = {
    bold: ["**", "**"],
    italic: ["*", "*"],
    strike: ["~~", "~~"],
    code: ["`", "`"],
    spoiler: ["||", "||"],
    quote: ["> ", ""],
  };

  function applyFormat(kind) {
    var input = $("#composerInput");
    var marks = FORMATS[kind];
    if (!input || !marks) return;

    var start = input.selectionStart;
    var end = input.selectionEnd;
    var text = input.value;
    var picked = text.slice(start, end) || (kind === "quote" ? "" : "text");

    input.value = text.slice(0, start) + marks[0] + picked + marks[1] + text.slice(end);
    input.focus();
    var inner = start + marks[0].length;
    input.setSelectionRange(inner, inner + picked.length);
    autosize(input);
    updateEmojiPop();
  }

  function humanSize(bytes) {
    var size = Number(bytes) || 0;
    if (size < 1024) return size + " B";
    if (size < 1024 * 1024) return (size / 1024).toFixed(size < 10240 ? 1 : 0) + " KB";
    return (size / (1024 * 1024)).toFixed(1) + " MB";
  }

  function uploadFile(file) {
    var form = new FormData();
    form.append("file", file);

    return fetch("/api/upload", { method: "POST", credentials: "same-origin", body: form })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (data) {
            if (!res.ok) {
              if (res.status === 401) showAuth();
              throw new Error(data.error || "That file didn't upload.");
            }
            return data.file;
          });
      });
  }

  function pickFiles(list) {
    if (!list || !list.length) return;

    var room = 4 - S.files.length;
    if (room <= 0) {
      toast("Up to 4 files per message.");
      return;
    }

    var chosen = Array.prototype.slice.call(list, 0, room);
    S.uploading += chosen.length;
    renderComposeFiles();

    chosen.forEach(function (file) {
      uploadFile(file)
        .then(function (uploaded) {
          S.files.push(uploaded);
        })
        .catch(function (error) {
          toast(error.message);
        })
        .then(function () {
          S.uploading -= 1;
          renderComposeFiles();
        });
    });
  }

  function renderComposeFiles() {
    var box = $("#composeFiles");
    if (!box) return;

    if (!S.files.length && !S.uploading) {
      box.hidden = true;
      box.innerHTML = "";
      return;
    }

    box.hidden = false;
    box.innerHTML =
      S.files
        .map(function (file) {
          var isImage = String(file.mime || "").indexOf("image/") === 0;
          return (
            '<span class="compose-file">' +
            (isImage
              ? '<img src="' + esc(file.url) + '" alt="" />'
              : '<span class="compose-file-icon">' + icon("paperclip", "ico--sm") + "</span>") +
            '<span class="compose-file-name">' + esc(file.name) + '</span>' +
            '<span class="compose-file-size">' + humanSize(file.size) + "</span>" +
            '<button type="button" class="compose-file-x" data-action="remove-file" data-id="' + esc(file.id) + '" aria-label="Remove attachment">' +
            icon("x", "ico--sm") +
            "</button></span>"
          );
        })
        .join("") +
      (S.uploading ? '<span class="compose-file is-uploading">Uploading ' + S.uploading + "…</span>" : "");
  }

  function filesHTML(files) {
    if (!files || !files.length) return "";

    return (
      '<div class="msg-files">' +
      files
        .map(function (file) {
          if (String(file.mime || "").indexOf("image/") === 0) {
            return (
              '<a class="msg-file-img" href="' +
              esc(file.url) +
              '" target="_blank" rel="noopener">' +
              '<img src="' +
              esc(file.url) +
              '" alt="' +
              esc(file.name) +
              '" loading="lazy" /></a>'
            );
          }

          return (
            '<a class="msg-file" href="' +
            esc(file.url) +
            '" target="_blank" rel="noopener" download>' +
            icon("paperclip", "ico--sm") +
            '<span class="msg-file-name">' +
            esc(file.name) +
            '</span><span class="msg-file-size">' +
            humanSize(file.size) +
            "</span></a>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function autosize(input) {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }

  function updateEmojiPop() {
    var input = $("#composerInput");
    var pop = $("#emojiPop");
    if (!input || !pop) return;

    var before = input.value.slice(0, input.selectionStart);
    var match = /(^|\s):([a-z0-9_+-]{2,})$/.exec(before);
    if (!match || !window.FleekEmoji) {
      pop.hidden = true;
      return;
    }

    var items = window.FleekEmoji.search(match[2], 6);
    if (!items.length) {
      pop.hidden = true;
      return;
    }

    S.emojiMatches = items;
    S.emojiIndex = 0;
    S.emojiStart = input.selectionStart - match[2].length - 1;
    pop.hidden = false;
    paintEmojiPop();
  }

  function paintEmojiPop() {
    var pop = $("#emojiPop");
    if (!pop) return;
    pop.innerHTML = S.emojiMatches
      .map(function (entry, index) {
        var glyph = window.FleekEmoji.charFor(entry.name);
        return (
          '<button type="button" class="emoji-item ' + (index === S.emojiIndex ? "is-active" : "") +
          '" data-action="emoji" data-index="' + index + '">' +
          "<span>" + esc(glyph) + "</span><span>" + esc(entry.name) + "</span>" +
          "<code>:" + esc(entry.name) + ":</code></button>"
        );
      })
      .join("");
  }

  function applyEmoji(name) {
    var input = $("#composerInput");
    if (!input || !name) return;
    var caret = input.selectionStart;
    input.value = input.value.slice(0, S.emojiStart) + ":" + name + ": " + input.value.slice(caret);
    var next = S.emojiStart + name.length + 3;
    input.setSelectionRange(next, next);
    input.focus();
    var pop = $("#emojiPop");
    if (pop) pop.hidden = true;
  }

  function sendMessage() {
    var input = $("#composerInput");
    var button = $("#sendBtn");
    if (!input) return;    var text = input.value.trim();

    if ((!text && !S.files.length) || !S.channelId) return;
    if (S.uploading) {
      toast("Wait for the upload to finish.");
      return;
    }

    button.disabled = true;
    api("/api/messages", {
      method: "POST",
      body: JSON.stringify({ channel: S.channelId, body: text, files: S.files.map(function (file) { return file.id; }) }),
    })
      .then(function (result) {
        input.value = "";
        S.files = [];
        renderComposeFiles();
        autosize(input);
        if (result.message.channel === S.channelId) {
          var known = S.messages.some(function (m) { return m.id === result.message.id; });
          if (!known) S.messages.push(result.message);
          S.lastTs = result.message.createdAt;
          renderFeed(true);
        }
        refreshState().catch(function () {});
      })
      .catch(function (error) {
        toast(error.message);
      })
      .then(function () {
        button.disabled = false;
        input.focus();
      });
  }

  /* ----------------------------------------------------------
     Navigation
     ---------------------------------------------------------- */

  function openHome() {
    S.mode = "home";
    S.dm = null;
    $("#app").classList.remove("nav-open");
    $("#app").classList.remove("chat-open");
    renderRail();
    renderSidebar();
    renderMembers();
    renderMain();
  }

  function mobileBack() {
    if (S.serverId && !S.dm && S.channelId) {
      S.channelId = null;
      $("#app").classList.remove("chat-open");
      renderRail();
      renderSidebar();
      renderMembers();
      return;
    }
    openHome();
  }

  function openServer(serverId) {
    var server = (S.data.servers || []).filter(function (s) { return s.id === serverId; })[0];
    if (!server) return;

    S.mode = "channel";
    S.serverId = server.id;
    S.dm = null;
    S.channelId = null;
    $("#app").classList.remove("nav-open");

    // On a phone, tapping a server shows its channel list; the conversation
    // slides in only after you pick a channel.
    if (window.matchMedia("(max-width: 820px)").matches) {
      $("#app").classList.remove("chat-open");
      renderRail();
      renderSidebar();
      renderMembers();
      return;
    }

    var primary = defaultChannelOf(server);
    if (primary) return openChannel(primary.id);

    renderRail();
    renderSidebar();
    renderMembers();
    renderMain();
  }

  function openChannel(channelId) {
    var server = activeServer();
    if (!server) return;

    var channel = server.channels.filter(function (c) { return c.id === channelId; })[0];
    if (!channel) return;

    S.mode = "channel";
    S.channelId = channelId;
    S.dm = null;
    $("#app").classList.remove("nav-open");
    $("#app").classList.add("chat-open");

    if (channel.type === "rules") {
      // Fetch before painting: rules change rarely, but a member who opens the
      // channel should never read a stale copy, even for a moment.
      return refreshState()
        .then(function () {
          renderRail();
          renderRules(channelById(channelId) || channel);
        })
        .catch(function () {
          renderRail();
          renderSidebar();
          renderMembers();
          renderRules(channel);
        });
    }

    renderRail();
    renderSidebar();
    renderMembers();
    renderMain();

    if (channel.type === "voice") return;
    if (channel.type === "forum") return loadForum(channelId);
    return loadMessages(channelId);
  }

  function openDm(friend) {
    S.mode = "channel";
    S.dm = friend;
    S.serverId = null;
    S.channelId = dmChannelFor(friend);
    $("#app").classList.remove("nav-open");
    $("#app").classList.add("chat-open");
    renderRail();
    renderSidebar();
    renderMain();
    return loadMessages(S.channelId);
  }

  /* ----------------------------------------------------------
     Servers
     ---------------------------------------------------------- */

  function openServerModal() {
    openOverlay(
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="serverTitle">' +
        '<div class="modal-head"><div><h2 id="serverTitle">Create a server</h2>' +
        "<p>Your server, your channels. Invite people with a code.</p></div>" +
        '<button class="icon-btn" data-action="close-overlay" aria-label="Close">' + icon("x") + "</button></div>" +
        '<div class="auth-tabs" role="tablist">' +
        '<button type="button" class="is-active" data-server-tab="create" role="tab">Create</button>' +
        '<button type="button" data-server-tab="join" role="tab">Join with code</button>' +
        "</div>" +
        '<form id="serverForm"><div class="field"><label for="serverName">Server name</label>' +
        '<input id="serverName" maxlength="40" placeholder="My server" required /></div>' +
        '<div class="field" id="serverCodeField" hidden><label for="serverCode">Invite code</label>' +
        '<input id="serverCode" maxlength="16" spellcheck="false" placeholder="abc12xyz" /></div>' +
        '<p class="form-error" id="serverError" hidden></p>' +
        '<div class="modal-actions"><button class="btn btn--primary" type="submit" id="serverSubmit">Create server</button></div>' +
        "</form></div>"
    );

    var mode = "create";
    document.querySelectorAll("[data-server-tab]").forEach(function (tab) {
      tab.addEventListener("click", function () {
        mode = tab.dataset.serverTab;
        document.querySelectorAll("[data-server-tab]").forEach(function (other) {
          other.classList.toggle("is-active", other === tab);
        });
        $("#serverName").closest(".field").hidden = mode !== "create";
        $("#serverName").required = mode === "create";
        $("#serverCodeField").hidden = mode !== "join";
        $("#serverCode").required = mode === "join";
        $("#serverSubmit").textContent = mode === "create" ? "Create server" : "Join server";
        $("#serverError").hidden = true;
      });
    });

    $("#serverForm").addEventListener("submit", function (event) {
      event.preventDefault();
      var errorEl = $("#serverError");
      var button = $("#serverSubmit");
      errorEl.hidden = true;
      button.disabled = true;

      var request =
        mode === "create"
          ? api("/api/servers", { method: "POST", body: JSON.stringify({ name: $("#serverName").value.trim() }) })
          : api("/api/servers/join", { method: "POST", body: JSON.stringify({ code: $("#serverCode").value.trim() }) });

      request
        .then(function (result) {
          closeOverlay();
          toast(mode === "create" ? "Server created" : "Joined server");
          return refreshState().then(function () {
            if (result.serverId) openServer(result.serverId);
          });
        })
        .catch(function (error) {
          errorEl.textContent = error.message;
          errorEl.hidden = false;
        })
        .then(function () {
          button.disabled = false;
        });
    });

    var name = $("#serverName");
    if (name) setTimeout(function () { name.focus(); }, 40);
  }

  var CHANNEL_KINDS = [
    ["text", "Text", "hash", "Messages, emoji and links."],
    ["voice", "Voice", "volume", "Talk and share your screen."],
    ["forum", "Forum", "forum", "Posts with titles and replies."],
    ["announcement", "Announcement", "megaphone", "Only the owner posts; everyone reads."],
    ["rules", "Rules", "book", "A read-only list the owner can edit."],
  ];

  function openChannelModal(prefillType) {
    var server = activeServer();
    if (!server) return;

    var chosen = prefillType || "text";

    openOverlay(
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="channelTitle">' +
        '<div class="modal-head"><div><h2 id="channelTitle">Create a channel</h2>' +
        "<p>Pick a type for " + esc(server.name) + ".</p></div>" +
        '<button class="icon-btn" data-action="close-overlay" aria-label="Close">' + icon("x") + "</button></div>" +
        '<div class="channel-types" id="channelTypes">' +
        CHANNEL_KINDS.map(function (entry) {
          return (
            '<button type="button" class="channel-type ' + (entry[0] === chosen ? "is-active" : "") + '" data-channel-type="' + entry[0] + '">' +
            icon(entry[2]) +
            '<span class="channel-type-name">' + entry[1] + "</span>" +
            '<span class="channel-type-note">' + entry[3] + "</span>" +
            "</button>"
          );
        }).join("") +
        "</div>" +
        '<form id="channelForm"><div class="field"><label for="channelName">Channel name</label>' +
        '<div class="prefix"><span id="channelPrefix">#</span><input id="channelName" maxlength="24" placeholder="new-channel" required /></div></div>' +
        '<p class="form-error" id="channelError" hidden></p>' +
        '<div class="modal-actions"><button class="btn btn--primary" type="submit">Create channel</button></div>' +
        "</form></div>"
    );

    var prefix = $("#channelPrefix");
    prefix.innerHTML = chosen === "text" ? "#" : icon(channelIcon(chosen), "ico--sm");

    document.querySelectorAll("[data-channel-type]").forEach(function (button) {
      button.addEventListener("click", function () {
        chosen = button.dataset.channelType;
        document.querySelectorAll("[data-channel-type]").forEach(function (other) {
          other.classList.toggle("is-active", other === button);
        });
        prefix.innerHTML = chosen === "text" ? "#" : icon(channelIcon(chosen), "ico--sm");
      });
    });

    $("#channelForm").addEventListener("submit", function (event) {
      event.preventDefault();
      var errorEl = $("#channelError");
      errorEl.hidden = true;

      api("/api/servers/" + encodeURIComponent(server.id) + "/channels", {
        method: "POST",
        body: JSON.stringify({ name: $("#channelName").value.trim(), type: chosen }),
      })
        .then(function (result) {
          closeOverlay();
          toast((chosen === "text" ? "#" : "") + result.channel.name + " created");
          return refreshState().then(function () {
            openChannel(result.channel.id);
          });
        })
        .catch(function (error) {
          errorEl.textContent = error.message;
          errorEl.hidden = false;
        });
    });

    setTimeout(function () { $("#channelName").focus(); }, 40);
  }

  function inviteLink(server) {
    return location.origin + "/invite/" + server.inviteCode;
  }

  function openInviteModal() {
    var server = activeServer();
    if (!server) return;

    openOverlay(
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="inviteTitle">' +
        '<div class="modal-head"><div><h2 id="inviteTitle">Invite people</h2>' +
        "<p>This link opens Fleek and joins " + esc(server.name) + ".</p></div>" +
        '<button class="icon-btn" data-action="close-overlay" aria-label="Close">' + icon("x") + "</button></div>" +
        '<div class="invite-code"><code id="inviteLink">' + esc(inviteLink(server)) + "</code>" +
        '<button class="btn btn--sm btn--primary" data-action="copy-invite" data-code="' + esc(server.inviteCode) + '">Copy link</button></div>' +
        (server.isOwner
          ? '<div class="field"><label for="inviteSlug">Custom link</label>' +
            '<div class="prefix invite-prefix"><span>' + esc(location.host + "/invite/") + '</span><input id="inviteSlug" maxlength="24" spellcheck="false" placeholder="my-server" value="' + esc(server.customCode || "") + '" /></div></div>' +
            '<p class="form-error" id="inviteError" hidden></p>' +
            '<div class="modal-actions"><button class="btn" id="inviteSave">Save custom link</button></div>'
          : "") +
        '<p class="settings-note">Anyone with the link can join. A custom name is unique across Fleek and can be changed any time.</p>' +
        "</div>"
    );

    var save = $("#inviteSave");
    if (save) {
      save.addEventListener("click", function () {
        save.disabled = true;
        api("/api/servers/" + encodeURIComponent(server.id) + "/invite", {
          method: "PATCH",
          body: JSON.stringify({ code: $("#inviteSlug").value.trim() }),
        })
          .then(function () {
            closeOverlay();
            toast("Invite link updated");
            return refreshState().then(openInviteModal);
          })
          .catch(function (error) {
            var el = $("#inviteError");
            el.textContent = error.message;
            el.hidden = false;
            save.disabled = false;
          });
      });
    }
  }

  function copyInvite(code) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(location.origin + "/invite/" + code).then(function () {
        toast("Invite link copied");
      });
    }
  }

  function inviteFromPath() {
    var match = /^\/invite\/([a-z0-9-]{3,24})\/?$/i.exec(location.pathname);
    return match ? match[1].toLowerCase() : null;
  }

  function joinInvite(code) {
    api("/api/servers/join", { method: "POST", body: JSON.stringify({ code: code }) })
      .then(function (result) {
        history.replaceState({}, "", "/");
        toast("Joined " + (result.name || "the server"));
        return refreshState().then(function () {
          openServer(result.serverId);
        });
      })
      .catch(function (error) {
        history.replaceState({}, "", "/");
        toast(error.message);
      });
  }

  /* ----------------------------------------------------------
     Voice channels
     ---------------------------------------------------------- */

  function onVoiceUpdate() {
    if (!S.data) return;
    renderSidebar();
    var channel = activeChannel();
    if (channel && channel.type === "voice" && !S.dm) renderVoice(channel);
  }

  function renderVoice(channel) {
    var voice = window.FleekVoice;
    var snap = voice
      ? voice.snapshot()
      : { joined: false, channelId: null, muted: false, sharing: false, participants: [], error: "" };
    var here = voice ? voice.isJoined(channel.id) : false;
    var people = here ? snap.participants : channel.voice || [];
    var elsewhereSub = snap.joined && snap.channelId && snap.channelId !== channel.id ? snap.channelId : null;
    var elsewhere = elsewhereSub ? channelById(elsewhereSub) : null;

    var controls = here
      ? '<button class="btn btn--sm' + (snap.muted ? " btn--primary" : "") + '" data-action="voice-mute">' +
        icon(snap.muted ? "mic-off" : "mic", "ico--sm") +
        (snap.muted ? " Unmute" : " Mute") +
        "</button>" +
        '<button class="btn btn--sm' + (snap.sharing ? " btn--primary" : "") + '" data-action="voice-share">' +
        icon("screen", "ico--sm") +
        (snap.sharing ? " Stop sharing" : " Share screen") +
        "</button>" +
        '<button class="btn btn--sm btn--danger" data-action="voice-leave">' +
        icon("phone-off", "ico--sm") +
        " Leave</button>"
      : '<button class="btn btn--primary" data-action="voice-join" data-channel="' + esc(channel.id) + '">' +
        icon("volume", "ico--sm") +
        " Join voice</button>";

    var tiles = people.length
      ? '<div class="voice-grid">' +
        people
          .map(function (person) {
            var isSelf = person.sub === me().sub;
            var sharing = isSelf ? snap.sharing : person.sharing;
            var muted = isSelf ? snap.muted : person.muted;
            return (
              '<div class="voice-tile ' + (sharing ? "is-sharing" : "") + (snap.speaking && snap.speaking[person.sub] ? " is-speaking" : "") + '">' +
              (sharing
                ? '<video class="voice-video" autoplay playsinline ' +
                  (isSelf ? 'muted data-voice-self="1"' : 'data-voice-video="' + esc(person.sub) + '"') +
                  "></video>"
                : '<div class="voice-avatar">' + avatar(person, "av--lg") + "</div>") +
              '<div class="voice-tile-foot">' +
              '<button class="voice-name" data-action="profile" data-sub="' + esc(person.sub) + '">' +
              esc(person.displayName) +
              "</button>" +
              (isSelf ? '<span class="voice-you">you</span>' : "") +
              (muted ? icon("mic-off", "ico--xs is-muted") : "") +
              (sharing ? '<span class="voice-live">LIVE</span>' : "") +
              "</div></div>"
            );
          })
          .join("") +
        "</div>"
      : '<div class="voice-empty"><p>Nobody is in here yet. Be the first.</p></div>';

    $("#main").innerHTML =
      '<div class="main-head">' +
      '<button class="icon-btn mobile-back-inline" data-action="mobile-back" aria-label="Back">' + icon("arrow-left") + "</button>" +
      icon("volume") +
      '<div style="min-width:0"><span class="main-title">' + esc(channel.name) + '</span><span class="main-sub">Voice channel</span></div>' +
      '<div class="main-head-right voice-controls">' + controls + "</div></div>" +
      '<div class="voice-stage" id="voiceStage">' +
      tiles +
      '<p class="voice-note">' +
      (here
        ? "Connected phone-to-phone: call audio and screen share go straight between you. Nothing is recorded or stored."
        : "Join to talk. Voice and screen share connect everyone directly, peer to peer.") +
      (elsewhere ? " You're still in " + esc(elsewhere ? elsewhere.name : "another channel") + " — joining here moves you." : "") +
      "</p>" +
      (snap.error ? '<p class="voice-error">' + esc(snap.error) + "</p>" : "") +
      "</div>";

    if (voice) voice.attachMedia($("#voiceStage"));
  }

  /* ----------------------------------------------------------
     Forum channels
     ---------------------------------------------------------- */

  function loadForum(channelId, postId, silent) {
    S.forumChannel = channelId;
    S.forumAt = Date.now();

    if (!S.forum || S.forum.channelId !== channelId) {
      S.forum = { channelId: channelId, posts: null, post: null, replies: [] };
    }

    if (postId) {
      return api("/api/forum/post?id=" + encodeURIComponent(postId))
        .then(function (result) {
          if (!S.forum || S.forum.channelId !== channelId) return;
          S.forum.post = result.post;
          S.forum.replies = result.replies;
          if (!S.forum.posts) S.forum.posts = [];
          if (activeChannel() && activeChannel().id === channelId) renderForum(activeChannel());
        })
        .catch(function (error) {
          toast(error.message);
        });
    }

    return api("/api/forum?channel=" + encodeURIComponent(channelId))
      .then(function (result) {
        if (!S.forum || S.forum.channelId !== channelId) return;
        S.forum.posts = result.posts;
        S.forum.post = null;
        S.forum.replies = [];
        if (silent && S.forum.post) return;
        if (activeChannel() && activeChannel().id === channelId) renderForum(activeChannel());
      })
      .catch(function (error) {
        if (!silent) toast(error.message);
      });
  }

  function pollForum() {
    if (!S.data || S.mode !== "channel" || document.hidden) return;
    var channel = activeChannel();
    if (!channel || channel.type !== "forum") return;
    if (S.forum && S.forum.post) return;
    if (S.forumChannel !== channel.id) return;
    if (Date.now() - S.forumAt < 8000) return;
    loadForum(channel.id, null, true);
  }

  function forumRowHTML(post) {
    var preview = String(post.body || "").replace(/\s+/g, " ").slice(0, 150);
    return (
      '<button class="forum-post" data-action="forum-open" data-post="' + esc(post.id) + '">' +
      avatar(post.author, "av--sm") +
      '<span class="forum-post-main">' +
      '<span class="forum-post-title">' + esc(post.title) + "</span>" +
      '<span class="forum-post-preview">' + esc(preview) + "</span>" +
      '<span class="forum-meta">' +
      esc(post.author.displayName) +
      " · " +
      plural(post.replies, "reply", "replies") +
      " · " +
      esc(dayOf(post.createdAt)) +
      "</span></span>" +
      '<span class="forum-replies">' + icon("message", "ico--sm") + (post.replies || 0) + "</span>" +
      "</button>"
    );
  }

  function forumDetailHTML(f) {
    var post = f.post;
    var md = window.FleekMarkdown
      ? function (text) { return window.FleekMarkdown.render(text, {}); }
      : function (text) { return "<p>" + esc(text) + "</p>"; };

    return (
      '<button class="btn btn--sm btn--ghost forum-back" data-action="forum-back">' +
      icon("arrow-left", "ico--sm") +
      " All posts</button>" +
      '<article class="forum-detail">' +
      "<h2>" + esc(post.title) + "</h2>" +
      '<div class="forum-meta">' +
      esc(post.author ? post.author.displayName : "Someone") +
      " · " +
      esc(dayOf(post.createdAt)) +
      " " +
      esc(timeOf(post.createdAt)) +
      "</div>" +
      '<div class="forum-body">' + md(post.body) + "</div>" +
      (post.canDelete
        ? '<button class="btn btn--sm btn--danger" data-action="forum-delete" data-post="' + esc(post.id) + '">Delete post</button>'
        : "") +
      "</article>" +
      '<div class="forum-replies-list">' +
      (f.replies.length
        ? f.replies
            .map(function (reply) {
              return (
                '<div class="forum-reply-row">' +
                avatar(reply.author, "av--sm") +
                '<div><div class="forum-meta">' +
                esc(reply.author.displayName) +
                " · " +
                esc(timeOf(reply.createdAt)) +
                '</div><div class="forum-body">' +
                md(reply.body) +
                "</div></div></div>"
              );
            })
            .join("")
        : '<p class="muted">No replies yet — be the first.</p>') +
      "</div>" +
      '<form class="forum-reply-form" id="forumReplyForm">' +
      '<textarea id="forumReplyInput" rows="2" maxlength="2000" placeholder="Reply to this post"></textarea>' +
      '<button class="btn btn--primary" type="submit">Reply</button>' +
      "</form>"
    );
  }

  function wireForumReply() {
    var form = $("#forumReplyForm");
    if (!form) return;

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var input = $("#forumReplyInput");
      var text = input.value.trim();
      if (!text || !S.forum || !S.forum.post) return;
      var button = form.querySelector("button");
      button.disabled = true;

      api("/api/forum/reply", { method: "POST", body: JSON.stringify({ post: S.forum.post.id, body: text }) })
        .then(function () {
          input.value = "";
          return loadForum(S.forum.channelId, S.forum.post.id);
        })
        .catch(function (error) {
          toast(error.message);
        })
        .then(function () {
          button.disabled = false;
        });
    });

    var input = $("#forumReplyInput");
    if (input) input.focus();
  }

  function renderForum(channel) {
    if (!channel) return;
    if (!S.forum || S.forum.channelId !== channel.id) {
      S.forum = { channelId: channel.id, posts: null, post: null, replies: [] };
      loadForum(channel.id);
    }

    var f = S.forum;
    var body;

    if (f.post) body = forumDetailHTML(f);
    else if (!f.posts) body = '<div class="feed-empty"><span>Loading posts…</span></div>';
    else if (!f.posts.length)
      body =
        '<div class="feed-empty"><strong>No posts yet</strong><span>Start the first thread — give it a title and a body.</span></div>';
    else body = '<div class="forum-list">' + f.posts.map(forumRowHTML).join("") + "</div>";

    $("#main").innerHTML =
      '<div class="main-head">' +
      '<button class="icon-btn mobile-back-inline" data-action="mobile-back" aria-label="Back">' + icon("arrow-left") + "</button>" +
      icon("forum") +
      '<div style="min-width:0"><span class="main-title">' + esc(channel.name) + '</span><span class="main-sub">Forum · posts and replies</span></div>' +
      '<div class="main-head-right">' +
      (f.post ? "" : '<button class="btn btn--sm btn--primary" data-action="forum-new">' + icon("plus", "ico--sm") + " New post</button>") +
      '<button class="icon-btn" data-action="forum-refresh" aria-label="Refresh posts" title="Refresh">' + icon("refresh") + "</button>" +
      "</div></div>" +
      '<div class="forum-stage">' + body + "</div>";

    if (f.post) wireForumReply();
  }

  function openForumPostModal() {
    var channel = activeChannel();
    if (!channel || channel.type !== "forum") return;

    openOverlay(
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="postTitle">' +
        '<div class="modal-head"><div><h2 id="postTitle">New post</h2>' +
        "<p>Give it a title. Replies live under the post." +
        "</p></div>" +
        '<button class="icon-btn" data-action="close-overlay" aria-label="Close">' + icon("x") + "</button></div>" +
        '<form id="postForm">' +
        '<div class="field"><label for="newPostTitle">Title</label>' +
        '<input id="newPostTitle" maxlength="90" required placeholder="What is this about?" /></div>' +
        '<div class="field"><label for="newPostBody">Post</label>' +
        '<textarea id="newPostBody" rows="6" maxlength="4000" placeholder="Write your post — markdown works."></textarea></div>' +
        '<p class="form-error" id="postError" hidden></p>' +
        '<div class="modal-actions"><button class="btn btn--primary" type="submit">Post it</button></div>' +
        "</form></div>"
    );

    $("#postForm").addEventListener("submit", function (event) {
      event.preventDefault();
      var errorEl = $("#postError");
      var button = $("#postForm").querySelector("button[type=submit]");
      errorEl.hidden = true;
      button.disabled = true;

      api("/api/forum", {
        method: "POST",
        body: JSON.stringify({
          channel: channel.id,
          title: $("#newPostTitle").value.trim(),
          body: $("#newPostBody").value.trim(),
        }),
      })
        .then(function (result) {
          closeOverlay();
          toast("Post published");
          return loadForum(channel.id, result.post.id);
        })
        .catch(function (error) {
          errorEl.textContent = error.message;
          errorEl.hidden = false;
        })
        .then(function () {
          button.disabled = false;
        });
    });

    setTimeout(function () { $("#newPostTitle").focus(); }, 40);
  }

  function deleteForumPost(postId) {
    confirmAction({
      title: "Delete this post?",
      body: "The post and every reply under it are removed for everyone.",
      confirmLabel: "Delete post",
      danger: true,
      onConfirm: function () {
        return api("/api/forum/post?id=" + encodeURIComponent(postId), { method: "DELETE" }).then(function () {
          closeOverlay();
          toast("Post deleted");
          var channel = activeChannel();
          if (channel) return loadForum(channel.id);
        });
      },
    });
  }

  /* ----------------------------------------------------------
     Rules channels
     ---------------------------------------------------------- */

  function renderRules(channel) {
    var server = activeServer();
    var owner = !!(server && server.isOwner);
    var lines = String(channel.rules || "").split("\n").filter(Boolean);

    $("#main").innerHTML =
      '<div class="main-head">' +
      '<button class="icon-btn mobile-back-inline" data-action="mobile-back" aria-label="Back">' + icon("arrow-left") + "</button>" +
      icon("book") +
      '<div style="min-width:0"><span class="main-title">' + esc(channel.name) + '</span><span class="main-sub">Server rules · read only</span></div>' +
      (owner
        ? '<div class="main-head-right"><button class="btn btn--sm" data-action="edit-rules">' +
          icon("edit", "ico--sm") +
          " Edit rules</button></div>"
        : "") +
      "</div>" +
      '<div class="rules-stage">' +
      (lines.length
        ? '<ol class="rules-list">' +
          lines
            .map(function (line) {
              return "<li>" + esc(line) + "</li>";
            })
            .join("") +
          "</ol>"
        : '<div class="voice-empty"><p>No rules written yet.</p></div>') +
      '<p class="voice-note">' +
      (owner
        ? "Only you can change these — everyone in the server can read them."
        : "Read-only. Only the server owner can change the rules.") +
      "</p></div>";
  }

  function openRulesEditor(channel) {
    if (!channel) return;

    openOverlay(
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="rulesTitle">' +
        '<div class="modal-head"><div><h2 id="rulesTitle">Edit rules</h2>' +
        "<p>One rule per line. Everyone in the server sees this list.</p></div>" +
        '<button class="icon-btn" data-action="close-overlay" aria-label="Close">' + icon("x") + "</button></div>" +
        '<div class="field"><label for="rulesText">Rules</label>' +
        '<textarea id="rulesText" rows="8" maxlength="4000">' +
        esc(channel.rules || "") +
        "</textarea></div>" +
        '<p class="form-error" id="rulesError" hidden></p>' +
        '<div class="modal-actions"><button class="btn btn--primary" id="rulesSave">Save rules</button></div></div>'
    );

    var button = $("#rulesSave");
    button.addEventListener("click", function () {
      button.disabled = true;
      api("/api/channels/" + encodeURIComponent(channel.id), {
        method: "PATCH",
        body: JSON.stringify({ rules: $("#rulesText").value }),
      })
        .then(function () {
          closeOverlay();
          toast("Rules updated");
          return refreshState();
        })
        .then(function () {
          if (S.channelId === channel.id) renderMain();
        })
        .catch(function (error) {
          var el = $("#rulesError");
          el.textContent = error.message;
          el.hidden = false;
        })
        .then(function () {
          button.disabled = false;
        });
    });
  }

  function openServerSettings(server) {
    openOverlay(
      '<div class="modal server-settings" role="dialog" aria-modal="true" aria-labelledby="serverSettingsTitle">' +
        '<div class="modal-head"><div><h2 id="serverSettingsTitle">Roles and permissions</h2>' +
        "<p>Roles decide who can manage channels, manage roles and post announcements.</p></div>" +
        '<button class="icon-btn" data-action="close-overlay" aria-label="Close">' + icon("x") + "</button></div>" +
        '<div class="server-identity">' +
        '<button type="button" class="avatar-preview" data-action="pick-server-icon" aria-label="Change server icon">' +
        (server.iconUrl
          ? '<img class="server-icon-img" src="' + esc(server.iconUrl) + '" alt="" />'
          : '<span class="server-icon server-icon--lg">' + esc(initials(server.name)) + "</span>") +
        '<span class="avatar-edit">Change</span></button>' +
        '<div class="server-identity-fields"><div class="field"><label for="serverNameEdit">Server name</label>' +
        '<input id="serverNameEdit" maxlength="40" value="' + esc(server.name) + '" /></div>' +
        '<button class="btn btn--sm" id="serverSaveName">Save name</button>' +
        '<span class="upload-note">The icon shows in the server rail and sidebar.</span></div>' +
        '<input type="file" id="serverIconFile" accept="image/png,image/jpeg,image/webp,image/gif" hidden />' +
        "</div>" +
        '<div class="role-list">' +
        (server.roles || []).map(function (role) {
          return (
            '<div class="role-row" data-role="' + esc(role.id) + '">' +
            '<span class="role-dot" style="background:' + esc(role.color || "var(--text-3)") + '"></span>' +
            '<span class="role-name">' + esc(role.name) + "</span>" +
            '<label class="role-perm"><input type="checkbox" data-role-bit="1"' + (role.permissions & 1 ? " checked" : "") + " /> Channels</label>" +
            '<label class="role-perm"><input type="checkbox" data-role-bit="2"' + (role.permissions & 2 ? " checked" : "") + " /> Roles</label>" +
            '<label class="role-perm"><input type="checkbox" data-role-bit="4"' + (role.permissions & 4 ? " checked" : "") + " /> Announce</label>" +
            '<button type="button" class="icon-btn role-delete" data-role-delete="' + esc(role.id) + '" aria-label="Delete role">' + icon("x", "ico--sm") + "</button>" +
            "</div>"
          );
        }).join("") +
        "</div>" +
        '<div class="role-create"><div class="field"><label for="newRoleName">New role</label>' +
        '<input id="newRoleName" maxlength="32" placeholder="Moderator" /></div>' +
        '<div class="role-create-row"><input id="newRoleColor" type="color" value="#5865f2" aria-label="Role color" />' +
        '<label class="role-perm"><input type="checkbox" id="newRoleChannels" /> Channels</label>' +
        '<label class="role-perm"><input type="checkbox" id="newRoleRoles" /> Roles</label>' +
        '<label class="role-perm"><input type="checkbox" id="newRoleAnnounce" /> Announce</label>' +
        '<button class="btn btn--sm btn--primary" id="roleCreate">Create</button></div></div></div>'
    );

    var nameSave = $("#serverSaveName");
    if (nameSave) {
      nameSave.addEventListener("click", function () {
        nameSave.disabled = true;
        api("/api/servers/" + encodeURIComponent(server.id), {
          method: "PATCH",
          body: JSON.stringify({ name: $("#serverNameEdit").value.trim() }),
        })
          .then(function () { toast("Server renamed"); return refreshState(); })
          .catch(function (error) { toast(error.message); nameSave.disabled = false; });
      });
    }

    var iconFile = $("#serverIconFile");
    if (iconFile) {
      iconFile.addEventListener("change", function () {
        var chosen = iconFile.files && iconFile.files[0];
        if (!chosen) return;

        compressImage(chosen)
          .then(function (dataUrl) {
            return api("/api/servers/" + encodeURIComponent(server.id) + "/icon", {
              method: "POST",
              body: JSON.stringify({ dataUrl: dataUrl }),
            });
          })
          .then(function () { toast("Server icon updated"); return refreshState(); })
          .catch(function (error) { toast(error.message); });
      });
    }

    var create = $("#roleCreate");
    create.addEventListener("click", function () {
      create.disabled = true;
      var bits =
        ($("#newRoleChannels").checked ? 1 : 0) |
        ($("#newRoleRoles").checked ? 2 : 0) |
        ($("#newRoleAnnounce").checked ? 4 : 0);

      api("/api/servers/" + encodeURIComponent(server.id) + "/roles", {
        method: "POST",
        body: JSON.stringify({ name: $("#newRoleName").value.trim(), color: $("#newRoleColor").value, permissions: bits }),
      })
        .then(function () {
          toast("Role created");
          return refreshState();
        })
        .then(function () {
          var fresh = (S.data.servers || []).filter(function (item) { return item.id === server.id; })[0];
          openServerSettings(fresh || server);
        })
        .catch(function (error) {
          toast(error.message);
          create.disabled = false;
        });
    });

    document.querySelectorAll("[data-role-bit]").forEach(function (box) {
      box.addEventListener("change", function () {
        var row = box.closest("[data-role]");
        var roleId = row.dataset.role;
        var bits = 0;
        row.querySelectorAll("[data-role-bit]").forEach(function (other) {
          if (other.checked) bits |= Number(other.dataset.roleBit);
        });
        var role = (server.roles || []).filter(function (item) { return item.id === roleId; })[0];

        api("/api/roles/" + encodeURIComponent(roleId), {
          method: "PATCH",
          body: JSON.stringify({
            name: role ? role.name : "role",
            color: role ? role.color : "",
            permissions: bits,
          }),
        })
          .then(function () { return refreshState(); })
          .catch(function (error) { toast(error.message); });
      });
    });

    document.querySelectorAll("[data-role-delete]").forEach(function (button) {
      button.addEventListener("click", function () {
        api("/api/roles/" + encodeURIComponent(button.dataset.roleDelete), { method: "DELETE" })
          .then(function () {
            toast("Role deleted");
            return refreshState();
          })
          .then(function () {
            var fresh = (S.data.servers || []).filter(function (item) { return item.id === server.id; })[0];
            openServerSettings(fresh || server);
          })
          .catch(function (error) { toast(error.message); });
      });
    });
  }

  function openMemberRoles(server, sub) {
    var member = (server.members || []).filter(function (item) { return item.sub === sub; })[0];
    if (!member) return;
    var roleIds = member.roleIds || [];

    openOverlay(
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="memberRolesTitle">' +
        '<div class="modal-head"><div><h2 id="memberRolesTitle">Roles for ' + esc(member.displayName) + "</h2>" +
        "<p>Toggle the roles this member holds.</p></div>" +
        '<button class="icon-btn" data-action="close-overlay" aria-label="Close">' + icon("x") + "</button></div>" +
        '<div class="role-picker">' +
        (server.roles || []).map(function (role) {
          return (
            '<label class="role-pick"><input type="checkbox" data-assign-role="' + esc(role.id) + '"' +
            (roleIds.indexOf(role.id) !== -1 ? " checked" : "") + " />" +
            '<span class="role-dot" style="background:' + esc(role.color || "var(--text-3)") + '"></span>' +
            esc(role.name) + "</label>"
          );
        }).join("") +
        "</div></div>"
    );

    document.querySelectorAll("[data-assign-role]").forEach(function (box) {
      box.addEventListener("change", function () {
        api("/api/servers/" + encodeURIComponent(server.id) + "/roles/assign", {
          method: "POST",
          body: JSON.stringify({ user: sub, role: box.dataset.assignRole, action: box.checked ? "add" : "remove" }),
        })
          .then(function () { return refreshState(); })
          .catch(function (error) { toast(error.message); });
      });
    });
  }

  /* ----------------------------------------------------------
     Context menus
     ---------------------------------------------------------- */

  function closeContextMenu() {
    var open = document.querySelector(".context-menu");
    if (open) open.remove();
  }

  function openContextMenu(items, x, y) {
    closeContextMenu();

    var menu = document.createElement("div");
    menu.className = "context-menu";
    menu.setAttribute("role", "menu");

    items.forEach(function (item) {
      if (item.separator) {
        var line = document.createElement("div");
        line.className = "context-sep";
        menu.appendChild(line);
        return;
      }

      var button = document.createElement("button");
      button.type = "button";
      button.className = "context-item" + (item.danger ? " is-danger" : "");
      button.setAttribute("role", "menuitem");
      button.textContent = item.label;
      button.addEventListener("click", function () {
        closeContextMenu();
        if (item.onSelect) item.onSelect();
      });
      menu.appendChild(button);
    });

    document.body.appendChild(menu);

    var box = menu.getBoundingClientRect();
    var left = Math.max(8, Math.min(x, window.innerWidth - box.width - 8));
    var top = Math.max(8, Math.min(y, window.innerHeight - box.height - 8));
    menu.style.left = left + "px";
    menu.style.top = top + "px";

    var first = menu.querySelector(".context-item");
    if (first) first.focus();
  }

  function channelFromHash() {
    var match = /^#c=([A-Za-z0-9-]{8,})$/.exec(location.hash || "");
    if (!match || !S.data) return null;

    var servers = S.data.servers || [];
    for (var i = 0; i < servers.length; i += 1) {
      var channel = servers[i].channels.filter(function (c) { return c.id === match[1]; })[0];
      if (channel) return { server: servers[i], channel: channel };
    }
    return null;
  }

  function copyChannelLink(channel) {
    var link = location.origin + "/#c=" + channel.id;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(link).then(function () {
        toast("Channel link copied");
      });
    }
  }

  function confirmAction(options) {
    openOverlay(
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">' +
        '<div class="modal-head"><div><h2 id="confirmTitle">' + esc(options.title) + "</h2>" +
        "<p>" + esc(options.body) + "</p></div></div>" +
        '<div class="modal-actions"><button class="btn" data-action="close-overlay">Cancel</button>' +
        '<button class="btn ' + (options.danger ? "btn--danger" : "btn--primary") + '" id="confirmGo">' +
        esc(options.confirmLabel) +
        "</button></div></div>"
    );

    var go = $("#confirmGo");
    go.addEventListener("click", function () {
      go.disabled = true;
      Promise.resolve(options.onConfirm()).catch(function (error) {
        go.disabled = false;
        toast(error.message);
      });
    });
  }

  function leaveServer(server) {
    return api("/api/servers/" + encodeURIComponent(server.id) + "/leave", { method: "POST", body: "{}" }).then(
      function () {
        closeOverlay();
        if (S.serverId === server.id) {
          S.serverId = null;
          S.channelId = null;
          S.mode = "home";
          S.dm = null;
        }
        toast("You left " + server.name);
        return refreshState().then(function () {
          if (S.mode === "home") openHome();
        });
      }
    );
  }

  function deleteServer(server) {
    return api("/api/servers/" + encodeURIComponent(server.id), { method: "DELETE" }).then(function () {
      closeOverlay();
      if (S.serverId === server.id) {
        S.serverId = null;
        S.channelId = null;
        S.mode = "home";
        S.dm = null;
      }
      toast("Server deleted");
      return refreshState().then(function () {
        if (S.mode === "home") openHome();
      });
    });
  }

  function serverMenu(server, event) {
    var items = [
      { label: "Invite People", onSelect: function () { openServer(server.id); openInviteModal(); } },
      { label: "Create Channel", onSelect: function () { openServer(server.id); openChannelModal(); } },
      { label: "Copy Invite Link", onSelect: function () { copyInvite(server.inviteCode); } },
      { separator: true },
    ];

    if (server.isOwner) {
      items.push({
        label: "Server Settings",
        onSelect: function () { openServerSettings(server); },
      });
      items.push({
        label: "Delete Server",
        danger: true,
        onSelect: function () {
          confirmAction({
            title: "Delete " + server.name + "?",
            body: "This removes the server, its channels and every message in them for everyone. There is no undo.",
            confirmLabel: "Delete server",
            danger: true,
            onConfirm: function () { return deleteServer(server); },
          });
        },
      });
    } else {
      items.push({
        label: "Leave Server",
        danger: true,
        onSelect: function () {
          confirmAction({
            title: "Leave " + server.name + "?",
            body: "You'll need a new invite code to come back. Your messages stay behind.",
            confirmLabel: "Leave server",
            danger: true,
            onConfirm: function () { return leaveServer(server); },
          });
        },
      });
    }

    openContextMenu(items, event.clientX, event.clientY);
  }

  function deleteChannel(channel) {
    return api("/api/channels/" + encodeURIComponent(channel.id), { method: "DELETE" }).then(function () {
      closeOverlay();
      toast("Channel deleted");
      return refreshState().then(function () {
        var server = activeServer();
        if (!server) return openHome();
        if (S.channelId === channel.id) return openServer(server.id);
      });
    });
  }

  function openRenameChannel(channel) {
    openOverlay(
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="renameTitle">' +
        '<div class="modal-head"><div><h2 id="renameTitle">Rename channel</h2>' +
        "<p>#" + esc(channel.name) + "</p></div>" +
        '<button class="icon-btn" data-action="close-overlay" aria-label="Close">' + icon("x") + "</button></div>" +
        '<form id="renameForm"><div class="field"><label for="renameName">Channel name</label>' +
        '<div class="prefix"><span>#</span><input id="renameName" maxlength="24" required value="' +
        esc(channel.name) +
        '" /></div></div>' +
        '<p class="form-error" id="renameError" hidden></p>' +
        '<div class="modal-actions"><button class="btn btn--primary" type="submit">Save changes</button></div></form></div>'
    );

    var input = $("#renameName");
    input.focus();
    input.select();

    $("#renameForm").addEventListener("submit", function (event) {
      event.preventDefault();
      var errorEl = $("#renameError");
      errorEl.hidden = true;

      api("/api/channels/" + encodeURIComponent(channel.id), {
        method: "PATCH",
        body: JSON.stringify({ name: $("#renameName").value.trim() }),
      })
        .then(function () {
          closeOverlay();
          toast("Channel renamed");
          return refreshState().then(function () { return openChannel(channel.id); });
        })
        .catch(function (error) {
          errorEl.textContent = error.message;
          errorEl.hidden = false;
        });
    });
  }

  function channelMenu(channel, event) {
    var server = activeServer();
    var channelType = channel.type === "rules" ? "rules" : null;
    var items = [
      { label: "Copy Link", onSelect: function () { copyChannelLink(channel); } },
      {
        label: "Copy Channel Name",
        onSelect: function () {
          if (!navigator.clipboard) return;
          navigator.clipboard.writeText(channel.name).then(function () {
            toast("Channel name copied");
          });
        },
      },
    ];

    if (server && server.isOwner) {
      items.push({ separator: true });
      items.push({ label: "Rename Channel", onSelect: function () { openRenameChannel(channel); } });
      items.push({
        label: "Delete Channel",
        danger: true,
        onSelect: function () {
          confirmAction({
            title: "Delete #" + channel.name + "?",
            body: "Every message in this channel is removed for everyone. There is no undo.",
            confirmLabel: "Delete channel",
            danger: true,
            onConfirm: function () { return deleteChannel(channel); },
          });
        },
      });
    }

    if (server && server.isOwner && channelType === "rules") {
      items.push({ separator: true });
      items.push({ label: "Edit Rules", onSelect: function () { openRulesEditor(channel); } });
    }

    openContextMenu(items, event.clientX, event.clientY);
  }

  /* ----------------------------------------------------------
     Friends
     ---------------------------------------------------------- */

  function relationOf(sub) {
    if (!S.data) return "none";
    if (S.data.friends.some(function (f) { return f.sub === sub; })) return "friend";
    if (S.data.incoming.some(function (f) { return f.sub === sub; })) return "incoming";
    if (S.data.outgoing.some(function (f) { return f.sub === sub; })) return "outgoing";
    return "none";
  }

  function personBySub(sub) {
    if (!S.data || !sub) return null;

    var pools = [S.data.friends || [], S.data.incoming || [], S.data.outgoing || []];
    (S.data.servers || []).forEach(function (server) {
      pools.push(server.members || []);
      (server.channels || []).forEach(function (channel) {
        if (channel.voice && channel.voice.length) pools.push(channel.voice);
      });
    });

    for (var i = 0; i < pools.length; i += 1) {
      var hit = pools[i].filter(function (member) { return member.sub === sub; })[0];
      if (hit) return hit;
    }
    return null;
  }

  function sharedServerNames(sub) {
    return ((S.data && S.data.servers) || [])
      .filter(function (server) {
        return (server.members || []).some(function (member) { return member.sub === sub; });
      })
      .map(function (server) { return server.name; });
  }

  function openProfile(sub) {
    if (!sub) return;

    if (sub === me().sub) {
      openOwnProfile();
      return;
    }

    var person = personBySub(sub);
    if (!person) {
      toast("That person isn't around anymore.");
      return;
    }

    var relation = relationOf(sub);

    api("/api/profile/" + encodeURIComponent(sub))
      .then(function (result) {
        renderProfileCard(person, relation, result.profile);
      })
      .catch(function () {
        renderProfileCard(person, relation, null);
      });
  }

  function renderProfileCard(person, relation, extra) {
    var handle = person.handle;
    var online = person.online !== false;
    var servers = sharedServerNames(person.sub);

    var actions =
      relation === "friend"
        ? '<button class="btn btn--primary" data-action="profile-message" data-sub="' + esc(person.sub) + '">Message</button>'
        : relation === "incoming"
        ? '<button class="btn btn--primary" data-action="profile-accept" data-handle="' + esc(handle) + '">Accept request</button>' +
          '<button class="btn btn--ghost" data-action="profile-decline" data-handle="' + esc(handle) + '">Decline</button>'
        : relation === "outgoing"
        ? '<button class="btn" disabled>Request sent</button>'
        : '<button class="btn btn--primary" data-action="profile-add" data-handle="' + esc(handle) + '">Add friend</button>';

    actions += '<button class="btn btn--ghost" data-action="profile-copy" data-handle="' + esc(handle) + '">Copy handle</button>';

    var relationLine =
      relation === "friend"
        ? "You're friends — you can message each other."
        : relation === "incoming"
        ? "They sent you a friend request."
        : relation === "outgoing"
        ? "Your friend request is waiting on them."
        : "Not friends yet. Add them to start a direct message.";

    var serverLine = servers.length
      ? (servers.length === 1 ? "You're both in " : "You share " + plural(servers.length, "server") + ": ") +
        servers.map(function (name) { return '<span class="profile-chip">' + esc(name) + "</span>"; }).join("")
      : "You don't share a server with them.";

    var server = (S.data.servers || []).filter(function (item) {
      return (item.members || []).some(function (member) { return member.sub === person.sub; });
    })[0];
    var member = server ? (server.members || []).filter(function (item) { return item.sub === person.sub; })[0] : null;

    var roleChips = "";
    if (server && member && member.roleIds && member.roleIds.length) {
      roleChips =
        '<div class="profile-roles">' +
        (server.roles || [])
          .filter(function (role) { return member.roleIds.indexOf(role.id) !== -1; })
          .map(function (role) {
            return (
              '<span class="role-chip" style="--role-color:' + esc(role.color || "var(--line)") + '">' + esc(role.name) + "</span>"
            );
          })
          .join("") +
        "</div>";
    }

    var statusText = (extra && extra.statusText) || person.statusText || "";
    var pronouns = (extra && extra.pronouns) || person.pronouns || "";
    var bio = (extra && extra.bio) || person.bio || "";
    var socials = (extra && extra.socials) || person.socials || {};
    var blockedByMe = !!(extra && extra.blockedByMe);
    var blockBtn =
      '<button class="btn btn--ghost" data-action="toggle-block" data-sub="' + esc(person.sub) + '" data-blocked="' +
      (blockedByMe ? "1" : "0") + '">' + (blockedByMe ? "Unblock" : "Block") + "</button>";
    var manage =
      server && server.isOwner && member
        ? '<button class="btn btn--ghost" data-action="manage-roles" data-sub="' + esc(person.sub) + '">Manage roles</button>'
        : "";

    openOverlay(
      '<div class="modal profile" role="dialog" aria-modal="true" aria-labelledby="profileTitle">' +
        profileBanner(person) +
        '<div class="profile-top">' +
        '<div class="profile-id">' +
        avatar(person, "av--lg") +
        '<div><h2 id="profileTitle" style="' + nameStyle(person) + '">' + esc(person.displayName) +
        (pronouns ? ' <span class="pronouns">' + esc(pronouns) + "</span>" : "") +
        '</h2><p class="profile-handle">@' + esc(handle) + "</p></div></div>" +
        '<button class="icon-btn" data-action="close-overlay" aria-label="Close">' + icon("x") + "</button></div>" +
        '<p class="profile-status ' + (online ? "is-online" : "is-offline") + '"><span class="status-dot"></span>' +
        (online ? (person.presence === "dnd" ? "Do not disturb" : person.presence === "idle" ? "Idle" : "Online") : "Offline") +
        "</p>" +
        (statusText ? '<p class="profile-custom-status">' + esc(statusText) + "</p>" : "") +
        (bio ? '<p class="profile-bio">' + esc(bio) + "</p>" : "") +
        socialsHTML(socials) +
        '<p class="profile-note">' + serverLine + "</p>" +
        '<p class="profile-note">' + relationLine + "</p>" +
        roleChips +
        (extra && extra.soundcloud ? soundcloudCard(extra.soundcloud) : "") +
        customProfileHTML(extra) +
        '<div class="profile-actions">' + actions + manage + blockBtn + "</div></div>"
    );
  }

  var SOCIAL_LINKS = {
    reddit: { label: "Reddit", url: function (handle) { return "https://www.reddit.com/user/" + encodeURIComponent(handle) + "/"; } },
    roblox: { label: "Roblox", url: function (handle) { return "https://www.roblox.com/users/profile?username=" + encodeURIComponent(handle); } },
    discord: { label: "Discord" },
    telegram: { label: "Telegram", url: function (handle) { return "https://t.me/" + encodeURIComponent(handle); } },
    tiktok: { label: "TikTok", url: function (handle) { return "https://www.tiktok.com/@" + encodeURIComponent(handle); } },
    website: { label: "Website" },
  };

  function socialsHTML(socials) {
    if (!socials) return "";

    var keys = Object.keys(SOCIAL_LINKS).filter(function (key) {
      return socials[key];
    });
    if (!keys.length) return "";

    return (
      '<div class="social-row">' +
      keys
        .map(function (key) {
          var meta = SOCIAL_LINKS[key];
          var value = String(socials[key]);
          var href = key === "website" ? value : meta.url ? meta.url(value) : "";
          var text = key === "website" ? value.replace(/^https?:\/\//, "") : "@" + value;
          var inner =
            '<span class="social-dot social-dot--' + key + '"></span>' +
            esc(meta.label) +
            (key === "discord" || key === "website" ? "" : ' <b>' + esc(text) + "</b>");

          return href
            ? '<a class="social-chip" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer nofollow">' + inner + "</a>"
            : '<span class="social-chip" title="' + esc(value) + '">' + inner + "</span>";
        })
        .join("") +
      "</div>"
    );
  }

  function soundcloudCard(sc) {
    return (
      '<div class="sc-card">' +
      (sc.art ? '<img class="sc-art" src="' + esc(sc.art) + '" alt="" />' : '<span class="sc-art is-empty"></span>') +
      '<span class="sc-meta"><span class="sc-title">' + esc(sc.title || "SoundCloud") + "</span>" +
      '<span class="sc-author">' + esc(sc.author || "") + "</span></span>" +
      '<button type="button" class="sc-play" data-action="sc-play" data-url="' + esc(sc.url) + '" aria-label="Play on SoundCloud">' +
      icon("volume", "ico--sm") +
      "</button></div>"
    );
  }

  function customProfileHTML(profile) {
    if (!profile || (!profile.css && !profile.html)) return "";
    var doc =
      "<!doctype html><html><head><meta charset='utf-8'><style>" +
      "body{margin:0;padding:12px;font:13px/1.55 system-ui,sans-serif;color:#dbdee1;background:transparent}" +
      "a{color:#00a8fc}img{max-width:100%;border-radius:6px}" +
      String(profile.css || "") +
      "</style></head><body>" +
      String(profile.html || "") +
      "</body></html>";
    return (
      '<div class="profile-custom"><iframe title="Custom profile" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" srcdoc="' +
      esc(doc) +
      '"></iframe></div>'
    );
  }

  function profileBanner(person) {
    if (person && person.bannerUrl) {
      return '<div class="profile-banner"><img src="' + esc(person.bannerUrl) + '" alt="" /></div>';
    }
    return '<div class="profile-banner is-fallback"><span></span></div>';
  }

  function openUserMenu() {
    var self = me();

    openOverlay(
      '<div class="modal user-menu" role="dialog" aria-modal="true" aria-labelledby="userMenuTitle">' +
        '<div class="modal-head"><div><h2 id="userMenuTitle">Your account</h2>' +
        "<p>@" + esc(self.handle) + "</p></div>" +
        '<button class="icon-btn" data-action="open-settings" data-section="account" aria-label="Settings" title="Settings">' +
        icon("gear") +
        "</button></div>" +
        '<button type="button" class="user-menu-profile" data-action="member" data-sub="' + esc(self.sub) + '">' +
        avatar(self, "av--lg") +
        "<span><b>" + esc(self.displayName) + "</b><small>" +
        (self.statusText ? esc(self.statusText) : "View your profile") +
        "</small></span></button>" +
        '<div class="user-menu-actions">' +
        '<button class="btn btn--primary" data-action="profile-edit">' + icon("edit", "ico--sm") + " Edit profile</button>" +
        '<button class="btn" data-action="open-settings" data-section="profile">Profile settings</button></div>' +
        '<p class="settings-note">Sign out lives in Settings → My Account, so it is never one stray tap away on your phone.</p></div>'
    );
  }

  function openOwnProfile() {
    var self = me();

    openOverlay(
      '<div class="modal profile" role="dialog" aria-modal="true" aria-labelledby="profileTitle">' +
        profileBanner(self) +
        '<div class="profile-top"><div class="profile-id">' +
        avatar(self, "av--lg") +
        '<div><h2 id="profileTitle">' +
        esc(self.displayName) + (me().verified ? verifiedBadge() : "") +
        '</h2><p class="profile-handle">@' +
        esc(self.handle) +
        "</p></div></div>" +
        '<button class="icon-btn" data-action="close-overlay" aria-label="Close">' +
        icon("x") +
        "</button></div>" +
        '<p class="profile-status is-online"><span class="status-dot"></span>Online</p>' +
        (self.bio ? '<p class="profile-bio">' + esc(self.bio) + "</p>" : "") +
        socialsHTML(self.socials) +
        '<p class="profile-note">This is how your profile looks to people you share a server with.</p>' +
        '<div class="profile-actions">' +
        '<button class="btn btn--primary" data-action="profile-edit">' +
        icon("edit", "ico--sm") +
        " Edit profile</button>" +
        '<button class="btn btn--ghost" data-action="profile-copy" data-handle="' +
        esc(self.handle) +
        '">Copy handle</button>' +
        "</div></div>"
    );
  }

  function openAddFriend(prefill) {
    openOverlay(
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="addTitle">' +
        '<div class="modal-head"><div><h2 id="addTitle">Add a friend</h2>' +
        "<p>Search by handle. They accept before you can DM.</p></div>" +
        '<button class="icon-btn" data-action="close-overlay" aria-label="Close">' + icon("x") + "</button></div>" +
        '<div class="field"><label for="friendSearch">Handle</label>' +
        '<div class="prefix"><span>@</span><input id="friendSearch" autocomplete="off" spellcheck="false" placeholder="someones_handle" value="' +
        esc(prefill || "") +
        '" /></div></div>' +
        '<div class="search-results" id="friendResults"><p class="muted">Start typing to search.</p></div>' +
        "</div>"
    );

    var input = $("#friendSearch");
    input.focus();
    input.select();

    var timer;
    input.addEventListener("input", function () {
      clearTimeout(timer);
      var query = input.value.trim().replace(/^@/, "");
      if (query.length < 1) {
        $("#friendResults").innerHTML = '<p class="muted">Start typing to search.</p>';
        return;
      }
      timer = setTimeout(function () {
        searchPeople(query);
      }, 220);
    });

    if (prefill) searchPeople(prefill);
  }

  function searchPeople(query) {
    api("/api/users?q=" + encodeURIComponent(query))
      .then(function (result) {
        var box = $("#friendResults");
        if (!box) return;
        if (!result.users.length) {
          box.innerHTML = '<p class="muted">No one found for “' + esc(query) + "”.</p>";
          return;
        }

        box.innerHTML = result.users
          .map(function (person) {
            var relation = relationOf(person.sub);
            var action = "";
            if (relation === "friend") action = '<span class="tag">Friend</span>';
            else if (relation === "outgoing") action = '<span class="tag tag--member">Requested</span>';
            else if (relation === "incoming") {
              action = '<button class="btn btn--sm btn--primary" data-action="accept-friend" data-handle="' + esc(person.handle) + '">Accept</button>';
            } else {
              action = '<button class="btn btn--sm" data-action="request-friend" data-handle="' + esc(person.handle) + '">Add</button>';
            }
            return (
              '<div class="person">' + avatar(person, "av--sm") +
              '<div class="person-info"><div class="person-name">' + esc(person.displayName) +
              '</div><div class="person-handle">@' + esc(person.handle) + "</div></div>" +
              '<div class="person-actions">' + action + "</div></div>"
            );
          })
          .join("");
      })
      .catch(function (error) {
        toast(error.message);
      });
  }

  function requestFriend(handle) {
    return api("/api/friends/request", { method: "POST", body: JSON.stringify({ handle: handle }) })
      .then(function (result) {
        toast(result.status === "accepted" ? "You're now friends with @" + handle : "Request sent to @" + handle);
        return refreshState().then(closeOverlay);
      })
      .catch(function (error) {
        toast(error.message);
      });
  }

  function respondFriend(handle, action) {
    return api("/api/friends/respond", { method: "POST", body: JSON.stringify({ handle: handle, action: action }) })
      .then(function () {
        toast(action === "accept" ? "You're now friends with @" + handle : "Request declined");
        return refreshState();
      })
      .catch(function (error) {
        toast(error.message);
      });
  }

  function removeFriend(handle) {
    return api("/api/friends/remove", { method: "POST", body: JSON.stringify({ handle: handle }) })
      .then(function () {
        toast("Removed @" + handle);
        if (S.dm && S.dm.handle === handle) {
          S.dm = null;
          openHome();
        }
        return refreshState();
      })
      .catch(function (error) {
        toast(error.message);
      });
  }

  /* ----------------------------------------------------------
     Settings (unchanged structure)
     ---------------------------------------------------------- */

  function openStatusEditor() {
    var self = me();
    var presence = self.presence || "online";

    openOverlay(
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="statusTitle">' +
        '<div class="modal-head"><div><h2 id="statusTitle">Set a status</h2>' +
        "<p>What are you up to? It clears on its own if you pick a duration.</p></div>" +
        '<button class="icon-btn" data-action="close-overlay" aria-label="Close">' + icon("x") + "</button></div>" +
        '<div class="field"><label for="statusText">Status</label>' +
        '<input id="statusText" maxlength="80" placeholder="sleeping" value="' + esc(self.statusText || "") + '" /></div>' +
        '<div class="field"><label for="statusPresence">Availability</label>' +
        '<select id="statusPresence">' +
        ["online", "idle", "dnd", "offline"]
          .map(function (value) {
            var label = { online: "Online", idle: "Idle", dnd: "Do not disturb", offline: "Invisible" }[value];
            return '<option value="' + value + '"' + (value === presence ? " selected" : "") + ">" + label + "</option>";
          })
          .join("") +
        "</select></div>" +
        '<div class="field"><label for="statusMinutes">Clear after</label>' +
        '<select id="statusMinutes"><option value="0">Never (until I change it)</option>' +
        '<option value="30">30 minutes</option><option value="60">1 hour</option>' +
        '<option value="240">4 hours</option><option value="1440">Today</option></select></div>' +
        '<p class="form-error" id="statusError" hidden></p>' +
        '<div class="modal-actions"><button class="btn" data-action="clear-status">Clear</button>' +
        '<button class="btn btn--primary" id="statusSave">Save status</button></div></div>'
    );

    var save = $("#statusSave");
    save.addEventListener("click", function () {
      save.disabled = true;
      api("/api/status", {
        method: "POST",
        body: JSON.stringify({
          text: $("#statusText").value,
          presence: $("#statusPresence").value,
          minutes: Number($("#statusMinutes").value) || 0,
        }),
      })
        .then(function () {
          closeOverlay();
          toast("Status updated");
          return refreshState();
        })
        .catch(function (error) {
          var el = $("#statusError");
          el.textContent = error.message;
          el.hidden = false;
          save.disabled = false;
        });
    });
  }

  function openSettings(section) {
    S.settingsSection = section || S.settingsSection || "account";
    S.pendingAvatar = null;
    S.pendingBanner = null;
    renderSettings();
  }

  function renderSettings() {
    var self = me();
    var nav = [
      ["account", "My Account"],
      ["profile", "My Profile"],
      ["appearance", "Appearance"],
    ];

    var navHTML = nav
      .map(function (item) {
        var active = item[0] === S.settingsSection ? "is-active" : "";
        return '<button type="button" class="' + active + '" data-action="settings-tab" data-section="' + item[0] + '">' + item[1] + "</button>";
      })
      .join("");

    openOverlay(
      '<div class="modal settings" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">' +
        '<aside class="settings-nav">' + navHTML + "</aside>" +
        '<div class="settings-body" id="settingsBody">' + settingsBodyHTML(self) + "</div>" +
        '<button class="icon-btn settings-close" data-action="close-overlay" aria-label="Close">' + icon("x") + "</button>" +
        "</div>"
    );

    wireAvatarInput();
    wireDecorInput();
  }

  function wireDecorInput() {
    var file = $("#decorFile");
    if (!file) return;

    file.addEventListener("change", function () {
      var chosen = file.files && file.files[0];
      if (!chosen) return;

      compressImage(chosen)
        .then(function (dataUrl) {
          return api("/api/decor", { method: "POST", body: JSON.stringify({ dataUrl: dataUrl }) });
        })
        .then(function () {
          var kind = $("#decorKind");
          if (kind) kind.value = "custom";
          toast("Custom decoration uploaded");
          return refreshState();
        })
        .catch(function (error) {
          profileError(error.message);
        });
    });
  }

  function settingsBodyHTML(self) {
    if (S.settingsSection === "account") {
      return (
        '<h2 id="settingsTitle">My Account</h2>' +
        '<p class="settings-lead">No email attached — your handle and password are the whole account.</p>' +
        '<div class="settings-row"><div><div class="label">Handle</div><div class="value">@' + esc(self.handle) + "</div></div></div>" +
        '<div class="settings-row"><div><div class="label">Display name</div><div class="value">' + esc(self.displayName) + "</div></div>" +
        '<button class="btn btn--sm" data-action="settings-tab" data-section="profile">Edit</button></div>' +
        '<div class="settings-row"><div><div class="label">Status</div><div class="value">' +
        (self.statusText ? esc(self.statusText) : "No custom status") +
        "</div></div>" +
        '<button class="btn btn--sm" data-action="edit-status">Edit</button></div>' +
        '<div class="settings-row"><div><div class="label">Password</div><div class="value">Hashed with PBKDF2</div></div></div>' +
        '<div class="settings-row"><div><div class="label">Session</div><div class="value">Signed in on this browser</div></div>' +
        '<button class="btn btn--sm btn--ghost" data-action="signout">Sign out</button></div>' +
        '<p class="settings-note">Signing out clears this browser only. Your account and messages stay on the server.</p>'
      );
    }

    if (S.settingsSection === "profile") {
      return (
        '<h2 id="settingsTitle">My Profile</h2>' +
        '<p class="settings-lead">This photo and name appear on your messages and member lists.</p>' +
        '<div class="profile-block">' +
        '<button type="button" class="avatar-preview" data-action="pick-avatar" aria-label="Change profile photo">' +
        avatar(self, "av--xl") +
        '<span class="avatar-edit">Change</span>' +
        "</button>" +
        '<div class="profile-actions">' +
        '<button class="btn btn--sm" data-action="pick-avatar">Upload a photo</button>' +
        (self.avatarUrl ? '<button class="btn btn--sm btn--ghost" data-action="remove-avatar">Remove photo</button>' : "") +
        '<span class="upload-note">Square image, resized to 256px. GIFs keep animating.</span>' +
        "</div></div>" +
        '<input type="file" id="avatarFile" accept="image/png,image/jpeg,image/webp,image/gif" hidden />' +
        '<div class="field"><label>Profile banner</label>' +
        '<div class="banner-preview' +
        (self.bannerUrl ? "" : " is-empty") +
        '">' +
        (self.bannerUrl ? '<img src="' + esc(self.bannerUrl) + '" alt="" />' : "<span>No banner yet</span>") +
        "</div>" +
        '<div class="profile-actions">' +
        '<button class="btn btn--sm" data-action="pick-banner">Upload banner</button>' +
        (self.bannerUrl ? '<button class="btn btn--sm btn--ghost" data-action="remove-banner">Remove banner</button>' : "") +
        '<span class="upload-note">Wide image, up to 3 MB. GIFs animate.</span>' +
        "</div></div>" +
        '<input type="file" id="bannerFile" accept="image/png,image/jpeg,image/webp,image/gif" hidden />' +
        '<div class="field"><label for="profileDisplay">Display name</label>' +
        '<input id="profileDisplay" maxlength="32" value="' + esc(self.displayName) + '" /></div>' +
        '<div class="field"><label for="nameFont">Name font</label>' +
        '<select id="nameFont">' +
        [["", "Default"], ["inter", "Inter"], ["georgia", "Georgia"], ["arialblack", "Arial Black"], ["verdana", "Verdana"], ["trebuchet", "Trebuchet"], ["courier", "Courier New"], ["impact", "Impact"], ["comic", "Comic Sans"], ["palatino", "Palatino"]]
          .map(function (item) { return '<option value="' + item[0] + '"' + (self.nameFont === item[0] ? " selected" : "") + ">" + item[1] + "</option>"; }).join("") +
        "</select></div>" +
        '<div class="field"><label>Name colours</label>' +
        '<div class="name-colors">' +
        '<input type="color" id="nameColor1" value="' + esc(self.nameColor1 || "#f2f3f5") + '" />' +
        '<input type="color" id="nameColor2" value="' + esc(self.nameColor2 || "#5865f2") + '" />' +
        '<label class="check"><input type="checkbox" id="nameGlowOn"' + (self.nameGlow ? " checked" : "") + " /> Glow</label>" +
        '<input type="color" id="nameGlowColor" value="' + esc(self.nameGlow || "#a78bfa") + '" />' +
        "</div></div>" +
        '<div class="field"><label for="profilePronouns">Pronouns</label>' +
        '<input id="profilePronouns" maxlength="24" placeholder="they/them" value="' + esc(self.pronouns || "") + '" /></div>' +
        '<div class="field"><label for="profileBio">Bio</label>' +
        '<textarea id="profileBio" rows="3" maxlength="300" placeholder="A line or two about you">' + esc(self.bio || "") + "</textarea></div>" +
        '<div class="field"><label>Socials</label>' +
        '<div class="socials-grid">' +
        [
          ["reddit", "Reddit", "username"],
          ["roblox", "Roblox", "username"],
          ["discord", "Discord", "username"],
          ["telegram", "Telegram", "username"],
          ["tiktok", "TikTok", "username"],
        ]
          .map(function (item) {
            return (
              '<label class="social-field"><span>' +
              item[1] +
              '</span><input id="social_' +
              item[0] +
              '" maxlength="60" spellcheck="false" placeholder="' +
              item[2] +
              '" value="' +
              esc((self.socials && self.socials[item[0]]) || "") +
              '" /></label>'
            );
          })
          .join("") +
        '<label class="social-field social-field--wide"><span>Website</span>' +
        '<input id="social_website" maxlength="300" spellcheck="false" placeholder="https://your.site" value="' +
        esc((self.socials && self.socials.website) || "") +
        '" /></label>' +
        "</div></div>" +
        '<div class="field"><label for="decorKind">Profile decoration</label>' +
        '<select id="decorKind">' +
        [
          ["none", "None"],
          ["glow", "Glow"],
          ["horns", "Devil horns"],
          ["wings", "Angel wings"],
          ["custom", "Custom image"],
        ]
          .map(function (pair) {
            return '<option value="' + pair[0] + '"' + ((self.decor && self.decor.kind === pair[0]) ? " selected" : "") + ">" + pair[1] + "</option>";
          })
          .join("") +
        "</select></div>" +
        '<div class="decor-editor">' +
        '<div class="crop-row"><label for="decorColor">Glow / accent</label><input id="decorColor" type="color" value="' + esc((self.decor && self.decor.color) || "#5865f2") + '" /></div>' +
        '<div class="crop-row"><label for="decorColor2">Horns / wings colour</label><input id="decorColor2" type="color" value="' + esc((self.decor && self.decor.color2) || "#ffffff") + '" /></div>' +
        '<label class="role-perm"><input type="checkbox" id="decorAnimated"' + (self.decor && self.decor.animated ? " checked" : "") + " /> Animate it</label>" +
        '<div class="profile-actions"><button class="btn btn--sm" data-action="pick-decor">Upload custom decoration</button>' +
        '<span class="upload-note">A transparent PNG sits on top of your photo. Animate it to make the decoration pulse or float.</span></div>' +
        '<input type="file" id="decorFile" accept="image/png,image/jpeg,image/webp,image/gif" hidden />' +
        "</div>" +
        '<div class="field"><label for="profileSoundcloud">SoundCloud track</label>' +
        '<input id="profileSoundcloud" maxlength="300" spellcheck="false" placeholder="https://soundcloud.com/artist/track" value="' + esc(self.soundcloudUrl || "") + '" /></div>' +
        '<div class="field"><label for="profileCss">Custom CSS</label>' +
        '<textarea id="profileCss" rows="4" maxlength="8000" spellcheck="false" placeholder="/* .profile-title { color: #f0b232 } */">' + esc(self.profileCss || "") + "</textarea></div>" +
        '<div class="field"><label for="profileHtml">Custom HTML</label>' +
        '<textarea id="profileHtml" rows="4" maxlength="8000" spellcheck="false" placeholder="&lt;b&gt;Hey, I make music&lt;/b&gt;">' + esc(self.profileHtml || "") + "</textarea></div>" +
        '<p class="settings-note">Custom CSS/HTML renders in a sandboxed box on your profile card, so it cannot touch the app. Keep any custom buttons pointing at real Fleek pages or actions — a link back to your profile is a good default. SoundCloud links turn into a small player card.</p>' +
        '<p class="form-error" id="profileError" hidden></p>' +
        '<div class="modal-actions" style="justify-content:flex-start">' +
        '<button class="btn btn--primary" data-action="save-profile">Save changes</button>' +
        "</div>"
      );
    }

    return (
      '<h2 id="settingsTitle">Appearance</h2>' +
      '<p class="settings-lead">Themes apply instantly and are remembered on this device.</p>' +
      '<div class="theme-grid">' +
      THEMES.map(function (theme) {
        var active = theme.id === S.theme ? "is-active" : "";
        var swatch = theme.swatch
          .map(function (color) {
            return '<span style="background:' + color + '"></span>';
          })
          .join("");
        return (
          '<button type="button" class="theme-card ' + active + '" data-action="set-theme" data-theme="' + theme.id + '" aria-pressed="' + (theme.id === S.theme) + '">' +
          '<span class="theme-swatch">' + swatch + "</span>" +
          '<span class="theme-name">' + theme.label + (theme.id === S.theme ? icon("check") : "") + "</span>" +
          "</button>"
        );
      }).join("") +
      "</div>" +
      '<p class="settings-note">Current theme: ' + esc(themeLabel(S.theme)) + ".</p>"
    );
  }

  /* Crop + background picker for profile photos. GIFs skip the crop so the
     animation survives. */
  var CROP = { src: null, zoom: 1, x: 0, y: 0, bg: "" };

  function openAvatarCropper(chosen) {
    if (!chosen.type || chosen.type.indexOf("image/") !== 0) {
      profileError("Pick an image file (PNG, JPEG, WebP or GIF).");
      return;
    }
    if (chosen.type === "image/gif") {
      compressImage(chosen)
        .then(function (dataUrl) {
          S.pendingAvatar = dataUrl;
          renderSettings();
          toast("Photo ready — press save");
        })
        .catch(function (error) {
          profileError(error.message);
        });
      return;
    }

    readAsDataUrl(chosen)
      .then(function (src) {
        return new Promise(function (resolve, reject) {
          var img = new Image();
          img.onload = function () {
            CROP = { src: img, zoom: 1, x: 0, y: 0, bg: "" };

            openOverlay(
              '<div class="modal crop" role="dialog" aria-modal="true" aria-labelledby="cropTitle">' +
                '<div class="modal-head"><div><h2 id="cropTitle">Crop your photo</h2>' +
                "<p>Drag to move, slide to zoom. Pick a background if the image is transparent.</p></div>" +
                '<button class="icon-btn" data-action="close-overlay" aria-label="Close">' + icon("x") + "</button></div>" +
                '<div class="crop-stage"><canvas id="cropCanvas" width="256" height="256"></canvas></div>' +
                '<div class="crop-row"><label for="cropZoom">Zoom</label>' +
                '<input id="cropZoom" type="range" min="1" max="3" step="0.01" value="1" /></div>' +
                '<div class="crop-row"><span>Background</span><div class="crop-bgs">' +
                '<button type="button" class="crop-bg is-active" data-crop-bg="" aria-label="Transparent"></button>' +
                '<button type="button" class="crop-bg" data-crop-bg="#000000" aria-label="Black"></button>' +
                '<button type="button" class="crop-bg" data-crop-bg="#ffffff" aria-label="White"></button>' +
                '<button type="button" class="crop-bg" data-crop-bg="#5865f2" aria-label="Blurple"></button>' +
                "</div></div>" +
                '<div class="modal-actions"><button class="btn" data-action="close-overlay">Cancel</button>' +
                '<button class="btn btn--primary" id="cropApply">Use photo</button></div></div>'
            );

            paintCrop();

            $("#cropZoom").addEventListener("input", function () {
              CROP.zoom = Number(this.value) || 1;
              paintCrop();
            });

            document.querySelectorAll("[data-crop-bg]").forEach(function (button) {
              button.addEventListener("click", function () {
                CROP.bg = button.dataset.cropBg;
                document.querySelectorAll("[data-crop-bg]").forEach(function (other) {
                  other.classList.toggle("is-active", other === button);
                });
                paintCrop();
              });
            });

            var canvas = $("#cropCanvas");
            var dragging = null;

            canvas.addEventListener("pointerdown", function (event) {
              dragging = { x: event.clientX - CROP.x, y: event.clientY - CROP.y };
              canvas.setPointerCapture(event.pointerId);
            });

            canvas.addEventListener("pointermove", function (event) {
              if (!dragging) return;
              CROP.x = event.clientX - dragging.x;
              CROP.y = event.clientY - dragging.y;
              paintCrop();
            });

            canvas.addEventListener("pointerup", function () {
              dragging = null;
            });

            $("#cropApply").addEventListener("click", function () {
              var out = canvas.toDataURL("image/webp", 0.9);
              if (out.indexOf("data:image/webp") !== 0) out = canvas.toDataURL("image/jpeg", 0.92);
              S.pendingAvatar = out;
              closeOverlay();
              renderSettings();
              toast("Photo ready — press save");
            });

            resolve();
          };
          img.onerror = function () {
            reject(new Error("That file isn't a valid image."));
          };
          img.src = src;
        });
      })
      .catch(function (error) {
        profileError(error.message);
      });
  }

  function paintCrop() {
    var canvas = $("#cropCanvas");
    if (!canvas || !CROP.src) return;

    var ctx = canvas.getContext("2d");
    var size = canvas.width;
    ctx.clearRect(0, 0, size, size);

    if (CROP.bg) {
      ctx.fillStyle = CROP.bg;
      ctx.fillRect(0, 0, size, size);
    }

    var img = CROP.src;
    var base = Math.max(size / img.width, size / img.height);
    var scale = base * CROP.zoom;
    var width = img.width * scale;
    var height = img.height * scale;
    var x = (size - width) / 2 + CROP.x;
    var y = (size - height) / 2 + CROP.y;

    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, x, y, width, height);
  }

  function wireAvatarInput() {
    var file = $("#avatarFile");
    if (file) {
      file.addEventListener("change", function () {
        var chosen = file.files && file.files[0];
        if (!chosen) return;
        openAvatarCropper(chosen);
      });
    }
  }

  function profileError(message) {
    var el = $("#profileError");
    if (!el) {
      toast(message);
      return;
    }
    el.textContent = message;
    el.hidden = false;
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(new Error("That file couldn't be read.")); };
      reader.readAsDataURL(file);
    });
  }

  function compressImage(file) {
    if (!file.type || file.type.indexOf("image/") !== 0) {
      return Promise.reject(new Error("Pick an image file (PNG, JPEG, WebP or GIF)."));
    }
    if (file.type === "image/gif") {
      if (file.size > 900 * 1024) {
        return Promise.reject(new Error("Animated avatars need to be under 900 KB."));
      }
      // Send the GIF untouched so the frames survive.
      return readAsDataUrl(file);
    }
    if (file.size > 8 * 1024 * 1024) {
      return Promise.reject(new Error("That image is over 8 MB — pick a smaller one."));
    }

    return readAsDataUrl(file).then(function (src) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var size = 256;
          var canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          var ctx = canvas.getContext("2d");
          var side = Math.min(img.width, img.height);
          ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
          var out = canvas.toDataURL("image/webp", 0.86);
          if (out.indexOf("data:image/webp") !== 0) out = canvas.toDataURL("image/jpeg", 0.9);
          if (out.length > 1500000) return reject(new Error("That image is too large."));
          resolve(out);
        };
        img.onerror = function () { reject(new Error("That file isn't a valid image.")); };
        img.src = src;
      });
    });
  }

  function saveProfile() {
    var self = me();
    var input = $("#profileDisplay");
    var displayName = input ? input.value.trim() : "";
    var button = document.querySelector('[data-action="save-profile"]');
    if (button) button.disabled = true;

    var chain = Promise.resolve();

    if (displayName && displayName !== self.displayName) {
      chain = chain.then(function () {
        return api("/api/profile", { method: "POST", body: JSON.stringify({ displayName: displayName }) });
      });
    }

    var soundcloud = $("#profileSoundcloud");
    var css = $("#profileCss");
    var html = $("#profileHtml");
    var bioEl = $("#profileBio");
    var pronounsEl = $("#profilePronouns");
    var decorKind = $("#decorKind");
    var decorColor = $("#decorColor");
    var decorColor2 = $("#decorColor2");
    var decorAnimated = $("#decorAnimated");

    if (soundcloud || css || html || bioEl || decorKind) {
      chain = chain.then(function () {
        var payload = {
          soundcloud: soundcloud ? soundcloud.value.trim() : "",
          profileCss: css ? css.value : "",
          profileHtml: html ? html.value : "",
          bio: bioEl ? bioEl.value : "",
          pronouns: pronounsEl ? pronounsEl.value : "",
          nameFont: ($("#nameFont") || {}).value || "",
          nameColor1: ($("#nameColor1") || {}).value || "",
          nameColor2: ($("#nameColor2") || {}).value || "",
          nameGlow: ($("#nameGlowOn") || {}).checked ? (($("#nameGlowColor") || {}).value || "#a78bfa") : "",
          socials: {
            reddit: ($("#social_reddit") || {}).value || "",
            roblox: ($("#social_roblox") || {}).value || "",
            discord: ($("#social_discord") || {}).value || "",
            telegram: ($("#social_telegram") || {}).value || "",
            tiktok: ($("#social_tiktok") || {}).value || "",
            website: ($("#social_website") || {}).value || "",
          },
        };

        if (decorKind) {
          payload.decor = {
            kind: decorKind.value,
            color: decorColor ? decorColor.value : "#5865f2",
            color2: decorColor2 ? decorColor2.value : "#ffffff",
            animated: !!(decorAnimated && decorAnimated.checked),
          };
        }

        return api("/api/profile", { method: "POST", body: JSON.stringify(payload) });
      });
    }

    if (S.pendingAvatar) {
      chain = chain.then(function () {
        return api("/api/avatar", { method: "POST", body: JSON.stringify({ dataUrl: S.pendingAvatar }) });
      });
    }

    if (S.pendingBanner) {
      chain = chain.then(function () {
        return api("/api/banner", { method: "POST", body: JSON.stringify({ dataUrl: S.pendingBanner }) });
      });
    }

    chain
      .then(function () {
        S.pendingAvatar = null;
        S.pendingBanner = null;
        toast("Profile updated");
        return refreshState();
      })
      .then(function () {
        renderSettings();
        if (S.mode === "channel" && S.channelId) return loadMessages(S.channelId);
      })
      .catch(function (error) {
        profileError(error.message);
      })
      .then(function () {
        if (button) button.disabled = false;
      });
  }

  function removeAvatar() {
    api("/api/avatar", { method: "DELETE" })
      .then(function () {
        S.pendingAvatar = null;
        toast("Photo removed");
        return refreshState();
      })
      .then(function () {
        renderSettings();
        if (S.mode === "channel" && S.channelId) return loadMessages(S.channelId);
      })
      .catch(function (error) {
        profileError(error.message);
      });
  }

  function removeBanner() {
    api("/api/banner", { method: "DELETE" })
      .then(function () {
        S.pendingBanner = null;
        toast("Banner removed");
        return refreshState();
      })
      .then(function () {
        renderSettings();
      })
      .catch(function (error) {
        profileError(error.message);
      });
  }

  function signOut() {
    api("/api/auth/logout", { method: "POST", body: "{}" })
      .catch(function () {})
      .then(function () {
        location.reload();
      });
  }

  /* ----------------------------------------------------------
     Events
     ---------------------------------------------------------- */

  document.addEventListener("click", function (event) {
    var trigger = event.target.closest("[data-action]");
    var overlay = $("#overlay");

    if (overlay && !overlay.hidden && event.target === overlay && overlay.dataset.dismissible === "1") {
      closeOverlay();
      return;
    }

    if (!trigger) {
      if (event.target.classList && event.target.classList.contains("spoiler")) {
        event.target.classList.toggle("is-open");
      }
      return;
    }

    if (
      window.matchMedia("(max-width: 820px)").matches &&
      trigger.closest("#sidebar") &&
      trigger.dataset.action !== "toggle-nav"
    ) {
      $("#app").classList.remove("nav-open");
    }

    switch (trigger.dataset.action) {
      case "home":
        openHome();
        break;
      case "open-friends":
        openFriends("all");
        break;
      case "user-menu":
        openUserMenu();
        break;
      case "mobile-back":
        mobileBack();
        break;
      case "friends-tab":
        openFriends(trigger.dataset.tab || "all");
        break;
      case "open-server":
        openServer(trigger.dataset.server);
        break;
      case "open-channel":
        openChannel(trigger.dataset.channel);
        break;
      case "add-server":
        openServerModal();
        break;
      case "add-channel":
        openChannelModal();
        break;
      case "invite":
        openInviteModal();
        break;
      case "copy-invite":
        copyInvite(trigger.dataset.code);
        break;
      case "add-friend":
        openAddFriend("");
        break;
      case "close-overlay":
        closeOverlay();
        break;
      case "dm": {
        var friend = (S.data.friends || []).filter(function (f) {
          return f.sub === trigger.dataset.sub;
        })[0];
        if (friend) openDm(friend);
        break;
      }
      case "member":
      case "profile":
        openProfile(trigger.dataset.sub);
        break;
      case "profile-message": {
        var person = (S.data.friends || []).filter(function (f) { return f.sub === trigger.dataset.sub; })[0];
        if (person) {
          closeOverlay();
          S.dm = null;
          openDm(person);
        }
        break;
      }
      case "profile-add":
        closeOverlay();
        requestFriend(trigger.dataset.handle);
        break;
      case "profile-accept":
        closeOverlay();
        respondFriend(trigger.dataset.handle, "accept");
        break;
      case "profile-decline":
        closeOverlay();
        respondFriend(trigger.dataset.handle, "decline");
        break;
      case "profile-copy":
        if (navigator.clipboard) {
          navigator.clipboard.writeText("@" + trigger.dataset.handle).then(function () {
            toast("Handle copied");
          });
        }
        break;
      case "request-friend":
        requestFriend(trigger.dataset.handle);
        break;
      case "accept-friend":
        respondFriend(trigger.dataset.handle, "accept");
        break;
      case "decline-friend":
        respondFriend(trigger.dataset.handle, "decline");
        break;
      case "remove-friend":
        removeFriend(trigger.dataset.handle);
        break;
      case "send":
        sendMessage();
        break;
      case "open-settings":
        openSettings(trigger.dataset.section || "account");
        break;
      case "settings-tab":
        S.settingsSection = trigger.dataset.section;
        renderSettings();
        break;
      case "set-theme":
        applyTheme(trigger.dataset.theme);
        renderSettings();
        toast(themeLabel(S.theme) + " theme");
        break;
      case "pick-avatar": {
        var fileInput = $("#avatarFile");
        if (fileInput) fileInput.click();
        break;
      }
      case "save-profile":
        saveProfile();
        break;
      case "remove-avatar":
        removeAvatar();
        break;
      case "signout":
        signOut();
        break;
      case "toggle-nav":
        $("#app").classList.toggle("nav-open");
        break;
      case "voice-join":
        if (window.FleekVoice) {
          window.FleekVoice.join(trigger.dataset.channel).then(function () {
            renderSidebar();
            var live = activeChannel();
            if (live && live.type === "voice") renderVoice(live);
          });
        }
        break;
      case "voice-leave":
        if (window.FleekVoice) {
          window.FleekVoice.leave();
          renderSidebar();
          var away = activeChannel();
          if (away && away.type === "voice") renderVoice(away);
        }
        break;
      case "voice-mute":
        if (window.FleekVoice) window.FleekVoice.toggleMute();
        break;
      case "voice-share":
        if (window.FleekVoice) {
          window.FleekVoice.toggleShare().then(function () {
            var sharing = activeChannel();
            if (sharing && sharing.type === "voice") renderVoice(sharing);
          });
        }
        break;
      case "forum-new":
        openForumPostModal();
        break;
      case "forum-open":
        if (S.channelId) loadForum(S.channelId, trigger.dataset.post);
        break;
      case "forum-back":
        if (S.channelId) loadForum(S.channelId);
        break;
      case "forum-refresh":
        if (S.channelId) {
          S.forum = null;
          loadForum(S.channelId);
        }
        break;
      case "forum-delete":
        deleteForumPost(trigger.dataset.post);
        break;
      case "edit-rules":
        openRulesEditor(activeChannel());
        break;
      case "format":
        applyFormat(trigger.dataset.fmt);
        break;
      case "attach": {
        var attachInput = $("#attachFile");
        if (attachInput) attachInput.click();
        break;
      }
      case "remove-file":
        S.files = S.files.filter(function (file) { return file.id !== trigger.dataset.id; });
        renderComposeFiles();
        break;
      case "profile-edit":
        closeOverlay();
        openSettings("profile");
        break;
      case "pick-banner": {
        var bannerInput = $("#bannerFile");
        if (bannerInput) bannerInput.click();
        break;
      }
      case "remove-banner":
        removeBanner();
        break;
      case "edit-status":
        openStatusEditor();
        break;
      case "clear-status":
        api("/api/status", { method: "POST", body: JSON.stringify({ text: "", presence: "online", minutes: 0 }) })
          .then(function () {
            closeOverlay();
            toast("Status cleared");
            return refreshState();
          })
          .catch(function (error) { toast(error.message); });
        break;
      case "server-settings": {
        var settingsServer = activeServer();
        if (settingsServer) openServerSettings(settingsServer);
        break;
      }
      case "manage-roles": {
        var roleServer = activeServer();
        if (roleServer) openMemberRoles(roleServer, trigger.dataset.sub);
        break;
      }
      case "toggle-block": {
        var blockedNow = trigger.dataset.blocked === "1";
        api("/api/block", {
          method: "POST",
          body: JSON.stringify({ sub: trigger.dataset.sub, action: blockedNow ? "unblock" : "block" }),
        })
          .then(function () {
            closeOverlay();
            toast(blockedNow ? "Unblocked" : "Blocked — their messages are hidden from you");
            return refreshState();
          })
          .catch(function (error) { toast(error.message); });
        break;
      }
      case "delete-message": {
        var mid = trigger.dataset.id;
        confirmAction({
          title: "Delete this message?",
          body: S.dm
            ? "It disappears for both of you. This can't be undone."
            : "It disappears for everyone in this channel. This can't be undone.",
          confirmLabel: "Delete message",
          danger: true,
          onConfirm: function () {
            return api("/api/messages/" + encodeURIComponent(mid), { method: "DELETE" }).then(function () {
              if (S.channelId) return loadMessages(S.channelId);
            });
          },
        });
        break;
      }
      case "pick-server-icon": {
        var iconInput = $("#serverIconFile");
        if (iconInput) iconInput.click();
        break;
      }
      case "pick-decor": {
        var decorInput = $("#decorFile");
        if (decorInput) decorInput.click();
        break;
      }
      case "sc-play": {
        var card = trigger.closest(".sc-card");
        if (card) {
          card.outerHTML =
            '<div class="sc-card is-playing"><iframe class="sc-frame" allow="autoplay" title="SoundCloud player" src="https://w.soundcloud.com/player/?url=' +
            encodeURIComponent(trigger.dataset.url) +
            '&color=%235865f2&auto_play=true&hide_related=true&show_comments=false&show_user=true&show_reposts=false&visual=true"></iframe></div>';
        }
        break;
      }
      case "emoji": {
        var entry = S.emojiMatches[Number(trigger.dataset.index)];
        if (entry) applyEmoji(entry.name);
        break;
      }
      case "copy-code": {
        var block = trigger.closest(".code-block");
        var code = block ? block.querySelector("code") : null;
        if (code && navigator.clipboard) {
          navigator.clipboard.writeText(code.textContent).then(function () {
            toast("Code copied");
          });
        }
        break;
      }
      default:
        break;
    }
  });

  document.addEventListener("keydown", function (event) {
    var key = String(event.key || "").toLowerCase();
    var devtools =
      event.key === "F12" ||
      ((event.ctrlKey || event.metaKey) && event.shiftKey && (key === "i" || key === "j" || key === "c" || key === "k")) ||
      ((event.ctrlKey || event.metaKey) && key === "u");

    if (devtools) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (event.key === "Escape") {
      closeContextMenu();
      var overlay = $("#overlay");
      if (overlay && !overlay.hidden && overlay.dataset.dismissible === "1") closeOverlay();
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (S.data) openAddFriend("");
    }
  });

  document.addEventListener("contextmenu", function (event) {
    var railServer = event.target.closest ? event.target.closest(".rail-server") : null;
    var channelRow = event.target.closest ? event.target.closest('[data-action="open-channel"]') : null;
    var serverHead = event.target.closest ? event.target.closest(".side-head") : null;

    event.preventDefault();

    if (railServer && S.data) {
      var server = S.data.servers.filter(function (s) { return s.id === railServer.dataset.server; })[0];
      if (server) return serverMenu(server, event);
    }

    if (serverHead) {
      var current = activeServer();
      if (current) return serverMenu(current, event);
    }

    if (channelRow) {
      var active = activeServer();
      var channel =
        active && active.channels.filter(function (c) { return c.id === channelRow.dataset.channel; })[0];
      if (channel) return channelMenu(channel, event);
    }
  });

  document.addEventListener("pointerdown", function (event) {
    if (!event.target.closest || !event.target.closest(".context-menu")) closeContextMenu();
  });

  window.addEventListener("resize", closeContextMenu);
  window.addEventListener("blur", closeContextMenu);

  /* Never fail silently: a script error shows a small retry bar with the
     real message, so a broken build can't look like dead buttons. */
  function showFatal(message) {
    var bar = $("#fatal");
    if (!bar) return;
    if (!bar.dataset.ready) {
      bar.innerHTML = "";
      var reload = document.createElement("button");
      reload.type = "button";
      reload.textContent = "Reload";
      reload.addEventListener("click", function () { location.reload(); });
      bar.appendChild(reload);
      bar.dataset.ready = "1";
    }
    bar.insertBefore(document.createTextNode(message + " "), bar.firstChild);
    bar.hidden = false;
  }

  window.addEventListener("error", function (event) {
    showFatal("Fleek hit a script error: " + (event.message || "unknown error"));
  });

  boot();
})();
