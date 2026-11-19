/* Inject Starlink Map into the dish's own page (http://192.168.100.1 or http://dishy.starlink.com). */
(function () {
  "use strict";
  if (window.__STARLINK_MAP_LOADED) return;
  window.__STARLINK_MAP_LOADED = true;

  function scriptBase(src) {
    return String(src || "").replace(/[^/]+(?:\?.*)?$/, "");
  }

  // Classic bookmarklet scripts are async, so currentScript can be null in
  // some WebKit builds. Fall back to the inject.js tag that was just added.
  function detectBase() {
    var src = "";
    if (document.currentScript && document.currentScript.src) {
      src = document.currentScript.src;
    }
    if (!src) {
      var scripts = document.getElementsByTagName("script");
      for (var i = scripts.length - 1; i >= 0; i--) {
        var candidate = scripts[i].src || "";
        if (/\/inject\.js(?:\?|#|$)/.test(candidate)) {
          src = candidate;
          break;
        }
      }
    }
    return src ? scriptBase(src) : "./";
  }

  var base = detectBase();
  window.__STARLINK_MAP_BASE = base;

  function add(rel, css) {
    return new Promise(function (resolve, reject) {
      var el;
      if (css) {
        el = document.createElement("link");
        el.rel = "stylesheet";
        el.href = rel;
      } else {
        el = document.createElement("script");
        el.src = rel;
      }
      el.onload = function () { resolve(); };
      el.onerror = function () { reject(new Error("Failed to load " + rel)); };
      document.documentElement.appendChild(el);
    });
  }

  function resetPage() {
    document.title = "Starlink Map";
    var html = document.documentElement;
    html.lang = "en";
    var metas = [
      ["viewport", "width=device-width, initial-scale=1, viewport-fit=cover"],
      ["apple-mobile-web-app-capable", "yes"],
      ["mobile-web-app-capable", "yes"],
      ["apple-mobile-web-app-status-bar-style", "black-translucent"],
      ["apple-mobile-web-app-title", "Starlink Map"],
      ["theme-color", "#070b10"],
    ];
    metas.forEach(function (m) {
      var el = document.querySelector('meta[name="' + m[0] + '"]');
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute("name", m[0]);
        document.head.appendChild(el);
      }
      el.setAttribute("content", m[1]);
    });
    document.body.innerHTML =
      '<div id="map"></div>' +
      '<div id="map-ui">' +
      '  <div class="topbar">' +
      '    <div class="brand-pill">' +
      '      <img src="' + base + 'icons/apple-touch-icon.png" alt="">' +
      '      <span class="name">Starlink Map</span>' +
      '      <span id="mode-tag" class="mode-tag hidden"></span>' +
      "    </div>" +
      '    <div id="banner" class="banner" role="status"></div>' +
      "  </div>" +
      '  <div class="sheet">' +
      '  <div class="fabs">' +
      '    <button type="button" class="fab" id="btn-trail" aria-label="Toggle breadcrumb trail">' +
      '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16c4-8 6 0 10-6 3 4 4 2 6 2"/><circle cx="20" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>' +
      "    </button>" +
      '    <button type="button" class="fab" id="btn-recenter" aria-label="Recenter on dish">' +
      '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>' +
      "    </button>" +
      "  </div>" +
      '  <div class="sheet-card">' +
      '    <div class="sheet-handle"></div>' +
      '    <div class="coords">' +
      '      <div class="coord"><label>Latitude</label><div class="val" id="lat">—</div></div>' +
      '      <div class="coord"><label>Longitude</label><div class="val" id="lon">—</div></div>' +
      '      <div class="coord"><label>Altitude</label><div class="val" id="alt">—</div></div>' +
      '      <div class="coord"><label>Source</label><div class="val" id="source">—</div></div>' +
      '      <div class="coord wide"><label>Accuracy</label><div class="val" id="acc">—</div></div>' +
      "    </div>" +
      '    <div class="meta-row">' +
      '      <span class="fresh" id="stamp">Waiting for a fix…</span>' +
      '      <button type="button" class="btn ghost" id="btn-setup" style="min-height:36px;padding:6px 10px;font-size:13px">Setup</button>' +
      "    </div>" +
      '    <div class="actions">' +
      '      <button type="button" class="btn primary" id="btn-refresh-live">Refresh now</button>' +
      '      <a class="btn primary hidden" id="btn-refresh-shortcut" href="shortcuts://run-shortcut?name=Starlink%20Map">Refresh</a>' +
      "    </div>" +
      "  </div></div>" +
      "</div>" +
      '<div id="setup" class="setup"></div>' +
      '<div id="toast" class="toast" role="status"></div>';

    // Minimal setup overlay so the Setup button still works when injected
    document.getElementById("setup").innerHTML =
      '<div class="setup-hero">' +
      '<img src="' + base + 'icons/icon-192.png" alt="">' +
      "<h1>Starlink Map</h1>" +
      "<p>This map is running inside the dish’s page so Safari can read location from the dish.</p>" +
      "</div>" +
      '<div class="card"><button type="button" class="btn primary" id="btn-demo" style="width:100%">Preview demo map</button></div>' +
      '<div class="card"><button type="button" class="btn" id="btn-try" style="width:100%">Retry dish connection</button><div id="try-result" class="note"></div></div>' +
      '<p class="fine-print"><a href="' + base + 'index.html">Open full setup page</a></p>' +
      '<button type="button" class="hidden" id="btn-copy-bookmarklet"></button>' +
      '<button type="button" class="hidden" id="btn-open-dish"></button>' +
      '<textarea id="bookmarklet-text" class="hidden"></textarea>' +
      '<div id="shortcut-url-sample" class="hidden"></div>' +
      '<div id="grpc-b64" class="hidden"></div>';
  }

  resetPage();

  add(base + "vendor/leaflet/leaflet.css", true)
    .then(function () { return add(base + "app.css", true); })
    .then(function () {
      if (window.L) return;
      return add(base + "vendor/leaflet/leaflet.js", false);
    })
    .then(function () { return add(base + "app.js", false); })
    .then(function () {
      window.StarlinkMap.start({ mode: "inject" });
    })
    .catch(function (err) {
      document.body.innerHTML =
        '<div style="font-family:-apple-system,sans-serif;padding:48px 20px;color:#eef6f4;background:#070b10;min-height:100vh">' +
        "<h1>Couldn’t load Starlink Map</h1>" +
        "<p>" + (err && err.message ? err.message : err) + "</p>" +
        "<p>Check that you still have internet access (map files and tiles are loaded from the host that served inject.js) and try the bookmark again.</p>" +
        "</div>";
    });
})();
