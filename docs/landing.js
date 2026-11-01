(() => {
  var APP = "https://fleeks.freebuff.page";
  var win = document.getElementById("lpWindow");
  var tabs = Array.prototype.slice.call(document.querySelectorAll("[data-lp-view]"));
  function setView(view) {
    if (!win) return;
    tabs.forEach(function (tab) { tab.classList.toggle("is-active", tab.getAttribute("data-lp-view") === view); });
    win.querySelectorAll("[data-lp-panel]").forEach(function (panel) {
      var on = panel.getAttribute("data-lp-panel") === view;
      panel.hidden = !on;
      if (on) { panel.classList.remove("is-entering"); void panel.offsetWidth; panel.classList.add("is-entering"); }
    });
  }
  tabs.forEach(function (tab) { tab.addEventListener("click", function () { setView(tab.getAttribute("data-lp-view")); }); });

  document.querySelectorAll("[data-go]").forEach(function (el) {
    el.addEventListener("click", function () {
      if (el.getAttribute("data-go") === "install") {
        alert("Open your browser menu and choose Install app / Add to Home Screen.");
        return;
      }
      location.href = APP;
    });
  });

  var landing = document.getElementById("landing");
  var progress = document.getElementById("landingProgress");
  var topBtn = document.getElementById("landingTop");
  topBtn.addEventListener("click", function () { landing.scrollTo({ top: 0, behavior: "smooth" }); });
  function onScroll() {
    var top = landing.scrollTop || 0;
    var max = landing.scrollHeight - landing.clientHeight;
    progress.style.width = (max > 0 ? Math.min(100, (top / max) * 100) : 0) + "%";
    topBtn.classList.toggle("is-visible", top > 140);
  }
  landing.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  setView("chat");
})();
