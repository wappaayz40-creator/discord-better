/* ============================================================
   Fleek · markdown renderer
   A small, dependency-free markdown subset tuned for chat:
   bold / italic / underline / strike / spoilers / inline code /
   fenced code (with a tiny highlighter) / quotes / lists /
   headings / links / mentions / channel references.
   Everything is escaped first, so message content can never
   inject HTML into the page.
   ============================================================ */

window.FleekMarkdown = (function () {
  "use strict";

  const ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  }

  const SAFE_URL = /^(https?:\/\/|mailto:)/i;

  /* ----------------------------------------------------------
     Tiny syntax highlighter
     Tokenises raw source (never HTML) and wraps tokens in spans.
     ---------------------------------------------------------- */

  const KEYWORDS = [
    "const", "let", "var", "function", "return", "if", "else", "for", "while",
    "import", "from", "export", "default", "new", "class", "extends", "await",
    "async", "this", "type", "interface", "true", "false", "null", "undefined",
    "def", "elif", "print", "in", "not", "and", "or", "with", "as", "pass",
    "yield", "try", "catch", "finally", "switch", "case", "break", "continue",
    "typeof", "instanceof", "enum", "public", "private", "readonly", "satisfies",
  ];

  const JS_TOKEN =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|(\b(?:const|let|var|function|return|if|else|for|while|import|from|export|default|new|class|extends|await|async|this|type|interface|true|false|null|undefined|try|catch|finally|switch|case|break|continue|typeof|instanceof|enum|public|private|readonly)\b)/g;

  const HASH_TOKEN =
    /(#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d+(?:\.\d+)?\b)|(\b(?:def|elif|print|in|not|and|or|with|as|pass|yield|return|if|else|for|while|import|from|class|true|false|None|True|False)\b)/g;

  function highlight(code, lang) {
    const language = (lang || "").toLowerCase();
    const supported = [
      "js", "javascript", "ts", "typescript", "jsx", "tsx", "json", "css",
      "py", "python", "sh", "bash", "sql",
    ];
    if (supported.indexOf(language) === -1) return esc(code);

    const re =
      language === "py" || language === "python" || language === "sh" || language === "bash"
        ? HASH_TOKEN
        : JS_TOKEN;
    re.lastIndex = 0;

    let out = "";
    let last = 0;
    let match;

    while ((match = re.exec(code))) {
      out += esc(code.slice(last, match.index));
      let cls = "tok-key";
      if (match[1]) cls = "tok-com";
      else if (match[2]) cls = "tok-str";
      else if (match[3]) cls = "tok-num";
      out += '<span class="' + cls + '">' + esc(match[0]) + "</span>";
      last = match.index + match[0].length;
    }
    out += esc(code.slice(last));
    return out;
  }

  function renderCode(code, lang) {
    const label = (lang || "text").toLowerCase();
    return (
      '<div class="code-block">' +
      '<div class="code-head">' +
      '<span class="code-lang">' + esc(label) + "</span>" +
      '<button type="button" class="code-copy" data-act="copy-code" aria-label="Copy code">' +
      '<svg class="ico" aria-hidden="true"><use href="#i-copy"></use></svg>' +
      "<span>Copy</span>" +
      "</button>" +
      "</div>" +
      "<pre><code>" + highlight(code, label) + "</code></pre>" +
      "</div>"
    );
  }

  /* ----------------------------------------------------------
     Inline formatting
     ---------------------------------------------------------- */

  function inline(raw, ctx) {
    ctx = ctx || {};
    const stash = [];
    // Same trap as the block stasher below: the index needs its own
    // parentheses or `"…I" + n - 1` evaluates to NaN.
    const keep = (html) => "\u0000I" + (stash.push(html) - 1) + "\u0000";

    let s = esc(raw);

    // Inline code first — its contents must never be formatted.
    s = s.replace(/`([^`\n]+)`/g, (m, code) =>
      keep('<code class="inline-code">' + code + "</code>")
    );

    // Spoilers.
    s = s.replace(/\|\|([^|\n]+)\|\|/g, (m, text) =>
      keep('<span class="spoiler" data-spoiler tabindex="0" role="button">' + text + "</span>")
    );

    // Explicit links: [label](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      if (!SAFE_URL.test(url)) return keep(label);
      return keep(
        '<a class="md-link" href="' + url + '" target="_blank" rel="noopener noreferrer">' +
          label +
          "</a>"
      );
    });

    // Bare links.
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, url) =>
      pre +
      keep(
        '<a class="md-link" href="' + url + '" target="_blank" rel="noopener noreferrer">' +
          url +
          "</a>"
      )
    );

    // Emphasis.
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_\n]+)__/g, "<u>$1</u>");
    s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");

    // Mentions — only names we know about, so emails stay intact.
    if (ctx.mentionNames instanceof Set) {
      s = s.replace(/(^|[\s(])@([A-Za-z0-9_.-]{2,32})/g, (m, pre, name) => {
        if (!ctx.mentionNames.has(name.toLowerCase())) return m;
        return (
          pre +
          '<span class="mention" data-mention="' + name + '" tabindex="0" role="button">@' +
          name +
          "</span>"
        );
      });
    }

    // Channel references — validated against the current hub's channels.
    if (ctx.channelNames instanceof Set) {
      s = s.replace(/(^|[\s(])#([a-z0-9][a-z0-9-]{1,31})/g, (m, pre, name) => {
        if (!ctx.channelNames.has(name.toLowerCase())) return m;
        return (
          pre +
          '<span class="channel-link" data-channel="' + name + '" tabindex="0" role="button">#' +
          name +
          "</span>"
        );
      });
    }

    // Restore protected spans.
    s = s.replace(/\u0000I(\d+)\u0000/g, (m, index) => stash[Number(index)]);
    return s;
  }

  /* ----------------------------------------------------------
     Block formatting
     ---------------------------------------------------------- */

  function render(text, ctx) {
    if (!text) return "";

    const blocks = [];
    // Parenthesise the index: `"…B" + push() - 1` would coerce to NaN and
    // every fenced block would render as the literal text "NaN".
    const store = (html) => "\u0000B" + (blocks.push(html) - 1) + "\u0000";

    const source = String(text).replace(/\r\n/g, "\n");

    // Fenced code blocks are pulled out before any other parsing so their
    // contents are never touched by emphasis, lists or mentions.
    const withoutFences = source.replace(
      /```([\w+#-]*)[ \t]*\n?([\s\S]*?)```/g,
      (m, lang, code) => store(renderCode(code.replace(/\n$/, ""), lang))
    );

    const lines = withoutFences.split("\n");
    const out = [];
    let paragraph = [];
    let i = 0;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      out.push("<p>" + paragraph.map((line) => inline(line, ctx)).join("<br>") + "</p>");
      paragraph = [];
    };

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // Standalone code block placeholder.
      if (/^\u0000B\d+\u0000$/.test(trimmed)) {
        flushParagraph();
        out.push(blocks[Number(trimmed.replace(/[^\d]/g, ""))]);
        i += 1;
        continue;
      }

      if (!trimmed) {
        flushParagraph();
        i += 1;
        continue;
      }

      const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
      if (heading) {
        flushParagraph();
        const level = heading[1].length;
        out.push(
          "<h" + level + ">" + inline(heading[2], ctx) + "</h" + level + ">"
        );
        i += 1;
        continue;
      }

      if (/^>\s?/.test(trimmed)) {
        flushParagraph();
        const quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        out.push("<blockquote>" + quote.map((q) => inline(q, ctx)).join("<br>") + "</blockquote>");
        continue;
      }

      if (/^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
        flushParagraph();
        const ordered = /^\d+\.\s+/.test(trimmed);
        const itemRe = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        const items = [];
        while (i < lines.length && itemRe.test(lines[i])) {
          items.push("<li>" + inline(itemRe.exec(lines[i])[1], ctx) + "</li>");
          i += 1;
        }
        const tag = ordered ? "ol" : "ul";
        out.push("<" + tag + ">" + items.join("") + "</" + tag + ">");
        continue;
      }

      if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
        flushParagraph();
        out.push('<hr class="md-rule">');
        i += 1;
        continue;
      }

      paragraph.push(line);
      i += 1;
    }

    flushParagraph();
    return out.join("");
  }

  /* Plain text version, used for previews and copy actions. */
  function toPlain(text) {
    return String(text || "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[*_~`|>#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  return { render, inline, toPlain, escapeHtml: esc };
})();
