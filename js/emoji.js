/* ============================================================
   Fleek · emoji system
   · shortcode registry with keywords (for :fire: autocomplete)
   · Twemoji image rendering with a native fallback
   · DOM pass that turns shortcodes + raw emoji into crisp images
   ============================================================ */

window.FleekEmoji = (function () {
  "use strict";

  const ASSET_BASE = "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/";

  /* [shortcode, character, keywords] */
  const RAW = [
    ["fire", "🔥", "hot flame lit"],
    ["sob", "😭", "cry sad tears"],
    ["smile", "😄", "happy grin"],
    ["joy", "😂", "lol laugh tears"],
    ["rofl", "🤣", "lol rolling"],
    ["heart", "❤️", "love red"],
    ["sparkles", "✨", "shine magic stars"],
    ["rocket", "🚀", "launch ship"],
    ["tada", "🎉", "party celebrate"],
    ["skull", "💀", "dead deadass"],
    ["eyes", "👀", "look watching"],
    ["thinking", "🤔", "hmm think"],
    ["thumbsup", "👍", "like yes approve"],
    ["wave", "👋", "hi hello bye"],
    ["clap", "👏", "applause nice"],
    ["100", "💯", "hundred perfect"],
    ["zap", "⚡", "fast energy lightning"],
    ["crown", "👑", "king queen admin"],
    ["gem", "💎", "diamond premium"],
    ["coffee", "☕", "caffeine morning"],
    ["pizza", "🍕", "food slice"],
    ["cat", "🐱", "kitty meow"],
    ["dog", "🐶", "puppy woof"],
    ["star", "⭐", "favourite gold"],
    ["sun", "☀️", "sunny bright"],
    ["crescent_moon", "🌙", "moon night late"],
    ["rainbow", "🌈", "pride colour"],
    ["boom", "💥", "explosion crash"],
    ["sweat_smile", "😅", "nervous laugh"],
    ["wink", "😉", "cheeky"],
    ["cool", "😎", "sunglasses chill"],
    ["heart_eyes", "😍", "love wow"],
    ["pray", "🙏", "thanks please"],
    ["saluting", "🫡", "yes sir respect"],
    ["handshake", "🤝", "deal agree"],
    ["ok_hand", "👌", "perfect nice"],
    ["point_right", "👉", "this look"],
    ["partying", "🥳", "party celebrate"],
    ["melting", "🫠", "melt overwhelmed"],
    ["scream", "😱", "shock scared"],
    ["angry", "😠", "mad grr"],
    ["poop", "💩", "poop bad"],
    ["ghost", "👻", "boo spooky"],
    ["alien", "👽", "ufo space"],
    ["robot", "🤖", "bot ai"],
    ["unicorn", "🦄", "magic rare"],
    ["avocado", "🥑", "toast green"],
    ["cherry", "🍒", "fruit sweet"],
    ["brain", "🧠", "smart big"],
    ["muscle", "💪", "strong flex"],
    ["trophy", "🏆", "win prize"],
    ["medal", "🏅", "award first"],
    ["dice", "🎲", "random luck"],
    ["art", "🎨", "paint design palette"],
    ["camera", "📸", "photo snap"],
    ["headphones", "🎧", "music listen audio"],
    ["music", "🎵", "note song"],
    ["guitar", "🎸", "band riff"],
    ["mic", "🎤", "stage speak karaoke"],
    ["laptop", "💻", "code dev work"],
    ["keyboard", "⌨️", "type keys"],
    ["bug", "🐛", "error fix dev"],
    ["lock", "🔒", "secure private"],
    ["key", "🔑", "access unlock"],
    ["bell", "🔔", "notify ping"],
    ["mail", "📬", "inbox message"],
    ["pin", "📌", "pinned saved"],
    ["white_check_mark", "✅", "done yes"],
    ["x", "❌", "no wrong"],
    ["question", "❓", "help ask"],
    ["exclamation", "❗", "important warn"],
    ["warning", "⚠️", "careful alert"],
    ["tea", "🍵", "calm gossip"],
    ["cake", "🍰", "birthday sweet"],
    ["cookie", "🍪", "snack treat"],
    ["strawberry", "🍓", "fruit red"],
    ["crystal_ball", "🔮", "future magic"],
    ["compass", "🧭", "explore direction"],
    ["hourglass", "⏳", "wait time"],
    ["moon_face", "🌚", "smirk night"],
    ["nerd", "🤓", "smart glasses"],
    ["shrug", "🤷", "dunno whatever"],
    ["facepalm", "🤦", "oops sigh"],
    ["raised_hands", "🙌", "yay praise"],
    ["flex", "🦾", "strong robot"],
    ["lab", "🧪", "experiment test"],
    ["ladder", "🪜", "climb step"],
    ["dna", "🧬", "science build"],
    ["satellite", "📡", "signal ping"],
    ["magic_wand", "🪄", "spell make"],
    ["sparkler", "🎇", "spark night"],
    ["scroll", "📜", "rules docs"],
    ["memo", "📝", "note write"],
  ];

  const LIST = RAW.map(([name, char, keywords]) => ({
    name,
    char,
    keywords: keywords || "",
  }));

  const BY_NAME = new Map(LIST.map((e) => [e.name, e]));
  const ALIASES = {
    like: "thumbsup",
    lol: "joy",
    cry: "sob",
    love: "heart",
    moon: "crescent_moon",
    party: "tada",
    celebrate: "tada",
    check: "white_check_mark",
    sad: "sob",
    hi: "wave",
    hello: "wave",
    bye: "wave",
    hot: "fire",
  };

  const POPULAR = [
    "fire", "joy", "heart", "thumbsup", "sparkles", "eyes",
    "rocket", "tada", "100", "skull", "clap", "sob",
    "thinking", "wave", "crown", "zap", "coffee", "cat",
  ];

  /* ----------------------------------------------------------
     Rendering
     ---------------------------------------------------------- */

  function codepoints(char) {
    return Array.from(char)
      .filter((c) => c !== "\uFE0F")
      .map((c) => c.codePointAt(0).toString(16))
      .join("-");
  }

  function urlFor(char) {
    return ASSET_BASE + codepoints(char) + ".svg";
  }

  /* HTML string for one emoji, by shortcode or character. */
  function markup(target, className) {
    const entry = BY_NAME.get(target) || BY_NAME.get(ALIASES[target]);
    const char = entry ? entry.char : target;
    if (!char) return "";
    const name = entry ? entry.name : "emoji";
    const cls = className || "emote";
    return (
      '<img class="' + cls + '" data-emoji data-char="' + char + '"' +
      ' alt="' + name + '" title="' + (entry ? ":" + entry.name + ":" : "") + '"' +
      ' draggable="false" loading="lazy" src="' + urlFor(char) + '">'
    );
  }

  function charFor(target) {
    const entry = BY_NAME.get(target) || BY_NAME.get(ALIASES[target]);
    return entry ? entry.char : target;
  }

  function nameForChar(char) {
    const found = LIST.find((e) => e.char === char);
    return found ? found.name : "";
  }

  // Any Twemoji asset that fails to load degrades to the native glyph,
  // so the UI still looks right when offline.
  document.addEventListener(
    "error",
    (event) => {
      const img = event.target;
      if (img && img.tagName === "IMG" && img.dataset && img.dataset.emoji) {
        img.replaceWith(document.createTextNode(img.dataset.char || ""));
      }
    },
    true
  );

  /* ----------------------------------------------------------
     DOM pass: shortcodes and raw emoji -> images
     ---------------------------------------------------------- */

  let emojiPattern = "\\p{RGI_Emoji}";
  try {
    new RegExp("\\p{RGI_Emoji}", "u");
  } catch (error) {
    emojiPattern =
      "[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{2B00}-\\u{2BFF}]" +
      "(?:\\uFE0F|\\u200D[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}])*";
  }

  const COMBINED = new RegExp("(:[a-z0-9_+-]+:)|(" + emojiPattern + ")", "giu");
  const SKIP = "code, pre, .no-emoji, textarea, script, style, .code-block";

  function replaceInTextNode(node, doc) {
    const text = node.nodeValue;
    if (!text || !/[:]|\p{Extended_Pictographic}/u.test(text)) return;

    COMBINED.lastIndex = 0;
    let match;
    let last = 0;
    let frag = null;

    while ((match = COMBINED.exec(text))) {
      const token = match[0];
      let html = "";

      if (match[1]) {
        const name = match[1].slice(1, -1).toLowerCase();
        if (BY_NAME.has(name) || ALIASES[name]) html = markup(name);
      } else {
        html = markup(token);
      }

      if (!html) continue;

      if (!frag) frag = doc.createDocumentFragment();
      if (match.index > last) {
        frag.appendChild(doc.createTextNode(text.slice(last, match.index)));
      }

      const holder = doc.createElement("span");
      holder.innerHTML = html;
      while (holder.firstChild) frag.appendChild(holder.firstChild);
      last = match.index + token.length;
    }

    if (!frag) return;
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  /* Walk an element and swizzle every emoji it contains. */
  function twemoji(root) {
    if (!root || !root.ownerDocument) return;
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || parent.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => replaceInTextNode(node, doc));
  }

  /* ----------------------------------------------------------
     Search (used by autocomplete + picker)
     ---------------------------------------------------------- */

  function search(query, limit) {
    const q = String(query || "").toLowerCase().replace(/^:/, "");
    const max = limit || 8;
    if (!q) {
      return POPULAR.slice(0, max).map((name) => BY_NAME.get(name)).filter(Boolean);
    }

    const scored = [];
    LIST.forEach((entry) => {
      const name = entry.name;
      let score = -1;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 80 - name.length;
      else if (name.includes(q)) score = 50;
      else if (entry.keywords.includes(q)) score = 30;
      if (score >= 0) scored.push({ entry, score });
    });

    return scored
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
      .slice(0, max)
      .map((item) => item.entry);
  }

  /* Is a whole message just a few emoji? Then render it jumbo. */
  function isEmojiOnly(text) {
    let value = String(text || "").trim();
    if (!value) return false;
    value = value.replace(/:[a-z0-9_+-]+:/gi, " ").trim();
    value = value.replace(/[\s.,!?]/g, "");
    if (!value) return true;
    const single = new RegExp("^(" + emojiPattern + ")+$", "u");
    return value.length <= 12 && single.test(value);
  }

  function pickerItems() {
    return LIST;
  }

  return {
    list: LIST,
    popular: POPULAR,
    byName: BY_NAME,
    aliases: ALIASES,
    markup,
    charFor,
    nameForChar,
    twemoji,
    search,
    isEmojiOnly,
    pickerItems,
  };
})();
