/* Starlink Map — gRPC-web client + Leaflet UI (no build step) */
(function (global) {
  "use strict";

  var DISH_HANDLE_PATH = "/SpaceX.API.Device.Device/Handle";
  // Request { get_location = 1017 {} } framed as gRPC-web
  var GET_LOCATION_FRAME = new Uint8Array([
    0x00, 0x00, 0x00, 0x00, 0x03, 0xca, 0x3f, 0x00,
  ]);
  var GET_LOCATION_B64 = "AAAAAAPKPwA=";
  var REFRESH_MS = 10000;
  var POSITION_SOURCE = {
    0: "AUTO",
    1: "NONE",
    2: "UT_INFO",
    3: "EXTERNAL",
    4: "GPS",
    5: "STARLINK",
    6: "GNC_FUSED",
    7: "GNC_BAD_SAT",
    8: "GNC_GPS",
    9: "GNC_PNT",
    10: "GNC_STATIC",
  };

  var state = {
    mode: "setup", // setup | live | demo | snapshot
    map: null,
    marker: null,
    accuracy: null,
    trail: null,
    trailOn: false,
    trailPts: [],
    lastFix: null,
    timer: null,
    follow: true,
  };

  /* ---------- protobuf / gRPC-web (hand-rolled, no codegen) ---------- */

  function readVarint(u8, i) {
    var n = 0;
    var shift = 0;
    while (i < u8.length) {
      var b = u8[i++];
      n += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) throw new Error("varint too long");
    }
    return [n, i];
  }

  function decodeMessage(u8) {
    var fields = {};
    var i = 0;
    function push(field, val) {
      if (!fields[field]) fields[field] = [];
      fields[field].push(val);
    }
    while (i < u8.length) {
      var tag = readVarint(u8, i);
      var field = Math.floor(tag[0] / 8);
      var wire = tag[0] - field * 8;
      i = tag[1];
      if (wire === 0) {
        var v = readVarint(u8, i);
        push(field, { t: "varint", v: v[0] });
        i = v[1];
      } else if (wire === 1) {
        if (i + 8 > u8.length) throw new Error("truncated fixed64");
        var dv = new DataView(u8.buffer, u8.byteOffset + i, 8);
        push(field, { t: "fixed64", f64: dv.getFloat64(0, true) });
        i += 8;
      } else if (wire === 2) {
        var len = readVarint(u8, i);
        var end = len[1] + len[0];
        if (end > u8.length) throw new Error("truncated length-delimited");
        push(field, { t: "bytes", bytes: u8.subarray(len[1], end) });
        i = end;
      } else if (wire === 5) {
        if (i + 4 > u8.length) throw new Error("truncated fixed32");
        var dv32 = new DataView(u8.buffer, u8.byteOffset + i, 4);
        push(field, { t: "fixed32", f32: dv32.getFloat32(0, true) });
        i += 4;
      } else {
        throw new Error("unsupported wire type " + wire);
      }
    }
    return fields;
  }

  function first(fields, n) {
    return fields[n] && fields[n][0];
  }

  function parseGrpcWeb(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var i = 0;
    var messages = [];
    var trailers = {};
    while (i + 5 <= u8.length) {
      var flags = u8[i];
      var len = ((u8[i + 1] << 24) | (u8[i + 2] << 16) | (u8[i + 3] << 8) | u8[i + 4]) >>> 0;
      i += 5;
      if (i + len > u8.length) throw new Error("truncated gRPC-web frame");
      var frame = u8.subarray(i, i + len);
      i += len;
      if (flags & 0x80) {
        var text = new TextDecoder("utf-8").decode(frame);
        text.split(/\r?\n/).forEach(function (line) {
          var c = line.indexOf(":");
          if (c > 0) {
            trailers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
          }
        });
      } else {
        messages.push(frame);
      }
    }
    return { messages: messages, trailers: trailers };
  }

  function parseGetLocationResponse(buf) {
    var parsed = parseGrpcWeb(buf);
    var status = parsed.trailers["grpc-status"];
    var msg = parsed.trailers["grpc-message"] || "";
    if (status && status !== "0") {
      var code = parseInt(status, 10);
      var err = new Error(msg || grpcStatusName(code));
      err.code = code;
      err.kind = classifyGrpc(code, msg);
      throw err;
    }
    if (!parsed.messages.length) {
      var err0 = new Error("The dish returned an empty response.");
      err0.kind = "empty";
      throw err0;
    }
    var response = decodeMessage(parsed.messages[0]);
    var statusField = first(response, 2);
    if (statusField && statusField.t === "bytes") {
      var st = decodeMessage(statusField.bytes);
      var codeF = first(st, 1);
      var msgF = first(st, 2);
      var scode = codeF && codeF.t === "varint" ? codeF.v : 0;
      var smessage = "";
      if (msgF && msgF.t === "bytes") {
        smessage = new TextDecoder("utf-8").decode(msgF.bytes);
      }
      if (scode) {
        var e = new Error(smessage || "Dish status code " + scode);
        e.code = scode;
        e.kind = classifyGrpc(scode, smessage);
        throw e;
      }
    }
    var locField = first(response, 1017);
    if (!locField || locField.t !== "bytes") {
      var e2 = new Error(
        "The dish did not include location data. As of May 2026 this is often limited to Priority plans, or location sharing may be off."
      );
      e2.kind = "unavailable";
      throw e2;
    }
    var loc = decodeMessage(locField.bytes);
    var llaField = first(loc, 1);
    if (!llaField || llaField.t !== "bytes") {
      var e3 = new Error(
        "Location access looks disabled, or the dish returned no coordinates."
      );
      e3.kind = "disabled";
      throw e3;
    }
    var lla = decodeMessage(llaField.bytes);
    var lat = first(lla, 1);
    var lon = first(lla, 2);
    var alt = first(lla, 3);
    if (!lat || !lon || lat.t !== "fixed64" || lon.t !== "fixed64") {
      var e4 = new Error("Could not parse latitude/longitude from the dish response.");
      e4.kind = "protocol";
      throw e4;
    }
    var sourceF = first(loc, 3);
    var sigmaF = first(loc, 4);
    var hSpeed = first(loc, 5);
    var vSpeed = first(loc, 6);
    var sourceNum = sourceF && sourceF.t === "varint" ? sourceF.v : null;
    return {
      lat: lat.f64,
      lon: lon.f64,
      altitude: alt && alt.t === "fixed64" ? alt.f64 : null,
      source: sourceNum == null ? null : POSITION_SOURCE[sourceNum] || String(sourceNum),
      sourceNum: sourceNum,
      accuracy_m: sigmaF && sigmaF.t === "fixed64" ? sigmaF.f64 : null,
      horizontal_speed_mps: hSpeed && hSpeed.t === "fixed64" ? hSpeed.f64 : null,
      vertical_speed_mps: vSpeed && vSpeed.t === "fixed64" ? vSpeed.f64 : null,
      timestamp: new Date().toISOString(),
    };
  }

  function grpcStatusName(code) {
    var names = {
      1: "CANCELLED",
      2: "UNKNOWN",
      3: "INVALID_ARGUMENT",
      4: "DEADLINE_EXCEEDED",
      5: "NOT_FOUND",
      7: "PERMISSION_DENIED",
      12: "UNIMPLEMENTED",
      13: "INTERNAL",
      14: "UNAVAILABLE",
      16: "UNAUTHENTICATED",
    };
    return names[code] || "gRPC error " + code;
  }

  function classifyGrpc(code, message) {
    var m = (message || "").toLowerCase();
    if (code === 7 || /permission|not enabled|not authorised|not authorized/.test(m)) {
      return "disabled";
    }
    if (/not available|priority|no longer/.test(m)) return "unavailable";
    if (code === 14 || code === 4) return "unreachable";
    return "grpc";
  }

  function classifyFetchError(err) {
    var msg = (err && err.message) || String(err);
    var low = msg.toLowerCase();
    if (err && err.kind) return err;
    if (err && err.name === "AbortError") {
      err.kind = "unreachable";
      err.message = "The dish did not respond in time.";
      return err;
    }
    if (/mixed content|insecure/.test(low)) {
      err.kind = "mixed";
      return err;
    }
    if (/failed to fetch|networkerror|load failed|typeerror/.test(low)) {
      // Could be CORS, offline, or dish unreachable — indistinguishable in Safari
      err.kind = "blocked";
      return err;
    }
    err.kind = err.kind || "unknown";
    return err;
  }

  async function fetchDishLocation() {
    var ctrl = new AbortController();
    var timer = setTimeout(function () {
      ctrl.abort();
    }, 10000);
    try {
      var res = await fetch(dishGrpcUrl(), {
        method: "POST",
        headers: {
          "Content-Type": "application/grpc-web+proto",
          "X-Grpc-Web": "1",
          "X-User-Agent": "grpc-web-javascript/0.1",
        },
        body: GET_LOCATION_FRAME,
        mode: "cors",
        cache: "no-store",
        signal: ctrl.signal,
      });
      var buf = new Uint8Array(await res.arrayBuffer());
      if (!res.ok && buf.length === 0) {
        var e = new Error("HTTP " + res.status + " from the dish.");
        e.kind = res.status === 403 || res.status === 401 ? "disabled" : "grpc";
        throw e;
      }
      return parseGetLocationResponse(buf);
    } catch (err) {
      throw classifyFetchError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- demo location ---------- */

  function demoFix() {
    var t = Date.now() / 1000;
    // Slow meander around a coastal point so the trail is visible
    var lat = 34.0135 + 0.004 * Math.sin(t / 25) + 0.0015 * Math.sin(t / 7);
    var lon = -118.495 + 0.005 * Math.cos(t / 32) + 0.001 * Math.cos(t / 11);
    var alt = 28 + 3 * Math.sin(t / 18);
    return {
      lat: lat,
      lon: lon,
      altitude: alt,
      source: "DEMO",
      accuracy_m: 2.4 + Math.abs(Math.sin(t / 8)),
      horizontal_speed_mps: 1.1,
      vertical_speed_mps: 0.02,
      timestamp: new Date().toISOString(),
      demo: true,
    };
  }

  /* ---------- origin / hash helpers ---------- */

  function isDishOrigin() {
    var h = location.hostname;
    return h === "192.168.100.1" || h === "dishy.starlink.com";
  }

  function isHttpsPublicPage() {
    return location.protocol === "https:" && !isDishOrigin();
  }

  // Directory of a script URL, including a cache-busting query string.
  function directoryOfScript(src) {
    return String(src || "").replace(/[^/]+(?:\?.*)?$/, "");
  }

  // Directory of the setup page. A file name (index.html) is dropped; a
  // directory without a trailing slash (…/alt-maps) is kept and slashed.
  function pageDirectory(href) {
    var u = new URL(href);
    var path = u.pathname || "/";
    var last = path.split("/").pop();
    if (!path.endsWith("/")) {
      if (last.indexOf(".") !== -1) path = path.slice(0, path.length - last.length);
      else path += "/";
    }
    if (!path.endsWith("/")) path += "/";
    u.pathname = path;
    u.search = "";
    u.hash = "";
    return u.href;
  }

  function assetBase() {
    if (global.__STARLINK_MAP_BASE) return global.__STARLINK_MAP_BASE;
    if (typeof document === "undefined") return "";
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i--) {
      var src = scripts[i].src || "";
      if (/\/(?:app|inject)\.js(?:\?|#|$)/.test(src)) return directoryOfScript(src);
    }
    return "";
  }

  // Absolute inject.js URL for this deployment. Built from the script that
  // is actually running, then from the page URL, so a subpath such as
  // /alt-maps/ is included. Never a root-absolute /inject.js.
  function injectScriptUrl(pageHref, appScriptSrc) {
    var dir = "";
    if (appScriptSrc) dir = directoryOfScript(appScriptSrc);
    else if (pageHref) dir = pageDirectory(pageHref);
    else if (global.__STARLINK_MAP_BASE) dir = global.__STARLINK_MAP_BASE;
    else dir = assetBase();
    if (!dir || !/^https?:\/\//i.test(dir)) {
      var page = pageHref || (typeof location !== "undefined" && location ? location.href : "");
      if (page) dir = pageDirectory(page);
    }
    if (dir && dir.charAt(dir.length - 1) !== "/") dir += "/";
    return (dir || "") + "inject.js";
  }

  function bookmarkletFor(injectUrl) {
    return (
      "javascript:(function(){var s=document.createElement('script');s.src='" +
      injectUrl +
      "?t='+Date.now();document.documentElement.appendChild(s);})();"
    );
  }

  function bookmarkletCode() {
    return bookmarkletFor(injectScriptUrl());
  }

  // Port 9201 is a different origin from the page (the port differs). The
  // dish allows the host its own UI is already using, and that UI calls
  // location.hostname:9201. On http://192.168.100.1 that is
  // http://192.168.100.1:9201. On http://dishy.starlink.com it stays on that
  // host. From any other page, use the well-known IP.
  function dishGrpcUrl() {
    var host = "192.168.100.1";
    if (typeof location !== "undefined" && location && location.hostname) {
      var h = location.hostname;
      if (h === "192.168.100.1" || h === "dishy.starlink.com") host = h;
    }
    return "http://" + host + ":9201" + DISH_HANDLE_PATH;
  }

  function parseHashPayload() {
    var h = location.hash || "";
    if (h.charAt(0) === "#") h = h.slice(1);
    if (!h) return null;
    var params = {};
    h.split("&").forEach(function (part) {
      var i = part.indexOf("=");
      if (i < 0) params[part] = "";
      else params[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
    });
    if (params.grpc) {
      try {
        var bin = b64ToBytes(params.grpc);
        return parseGetLocationResponse(bin);
      } catch (e) {
        console.warn("Could not parse #grpc payload", e);
        throw e;
      }
    }
    if (params.lat && params.lon) {
      return {
        lat: parseFloat(params.lat),
        lon: parseFloat(params.lon),
        altitude: params.alt != null && params.alt !== "" ? parseFloat(params.alt) : null,
        source: params.source || "SHORTCUT",
        accuracy_m: params.acc ? parseFloat(params.acc) : null,
        timestamp: new Date().toISOString(),
        snapshot: true,
      };
    }
    return null;
  }

  function b64ToBytes(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------- UI ---------- */

  function $(id) {
    return document.getElementById(id);
  }

  function fmtNum(n, digits) {
    if (n == null || !isFinite(n)) return "—";
    return Number(n).toFixed(digits);
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    try {
      var d = new Date(iso);
      return d.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch (e) {
      return iso;
    }
  }

  function showToast(text) {
    var el = $("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      el.classList.remove("show");
    }, 1800);
  }

  function setBanner(kind, title, html) {
    var el = $("banner");
    if (!title) {
      el.className = "banner";
      el.innerHTML = "";
      return;
    }
    el.className = "banner show" + (kind === "warn" ? " warn" : "");
    el.innerHTML = '<div class="banner-title">' + title + "</div>" + (html || "");
  }

  function errorCopy(kind, raw) {
    var enable =
      "In the Starlink app, go to Settings → Advanced → Debug Data, and turn on <strong>Allow access on local network</strong> under Starlink Location. Some newer dishes and non-Priority plans no longer show this toggle, and as of May 2026 location over this API is often limited to Priority plans.";
    var wifi =
      "Your iPhone must be on the same Starlink network, and it must be able to reach <code>192.168.100.1</code>. That usually works on Starlink’s own Wi‑Fi. With a third-party router you may need a route to the dish.";

    if (kind === "mixed") {
      return {
        title: "Safari blocked this page from talking to the dish",
        html:
          "<p>This page is served over HTTPS, and the dish only speaks HTTP. iOS Safari treats that as mixed content and blocks it. A public website usually also fails CORS (the dish does not allow other websites to read its gRPC-web API).</p>" +
          "<p>Use the live-map bookmark on the dish’s own page, or the iOS Shortcut — both are on this setup screen.</p>",
        warn: true,
      };
    }
    if (kind === "blocked") {
      return {
        title: "Safari couldn’t reach the dish from this page",
        html:
          "<p>This is the expected result for a normal website. The dish’s gRPC-web port (9201) does not send CORS headers that would let another site read location, and the required <code>application/grpc-web+proto</code> header triggers a preflight the dish does not authorize. That finding comes from public Starlink research and SpaceX’s own statement that cross-origin policy is enforced on port 9201 — not from a test against your dish.</p>" +
          "<p><strong>What to do:</strong> use the live-map bookmark (run it while you’re on <a href=\"http://192.168.100.1\">http://192.168.100.1</a>) or the iOS Shortcut below. Those don’t depend on the dish allowing this website.</p>",
        warn: true,
      };
    }
    if (kind === "disabled") {
      return {
        title: "Location access isn’t enabled",
        html: "<p>" + enable + "</p><p>" + wifi + "</p>",
      };
    }
    if (kind === "unavailable") {
      return {
        title: "The dish didn’t return coordinates",
        html:
          "<p>" +
          enable +
          "</p><p>If the toggle is already on, your plan may no longer expose location on the local API. That change was announced for most residential plans in May 2026, with an exception reported for some Priority plans. We could not verify your plan from here.</p>",
      };
    }
    if (kind === "unreachable") {
      return {
        title: "Can’t reach the Starlink dish",
        html: "<p>" + wifi + "</p><p>Make sure the dish is online, then try again.</p>",
      };
    }
    return {
      title: "Couldn’t get a location",
      html: "<p>" + (escapeHtml(raw || "Unknown error")) + "</p><p>" + wifi + "</p>",
    };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function showSetup(visible) {
    $("setup").classList.toggle("show", !!visible);
    $("map-ui").classList.toggle("hidden", !!visible);
  }

  function modeLabel(mode) {
    if (mode === "demo") return "Demo";
    if (mode === "snapshot") return "Shortcut";
    if (mode === "live") return "Live";
    return "";
  }

  function renderFix(fix) {
    state.lastFix = fix;
    $("lat").textContent = fmtNum(fix.lat, 6) + "°";
    $("lon").textContent = fmtNum(fix.lon, 6) + "°";
    $("alt").textContent =
      fix.altitude == null || !isFinite(fix.altitude)
        ? "—"
        : fmtNum(fix.altitude, 1) + " m";
    $("source").textContent = fix.source || "—";
    $("acc").textContent =
      fix.accuracy_m == null || !isFinite(fix.accuracy_m)
        ? "—"
        : "± " + fmtNum(fix.accuracy_m, 1) + " m";
    $("stamp").textContent = "Updated " + fmtTime(fix.timestamp);
    $("stamp").classList.remove("is-stale");
    $("mode-tag").textContent = modeLabel(state.mode);
    $("mode-tag").className =
      "mode-tag " +
      (state.mode === "demo" ? "is-demo" : state.mode === "snapshot" ? "is-snap" : "is-live");
    $("mode-tag").classList.toggle("hidden", !state.mode || state.mode === "setup");

    $("btn-refresh-shortcut").classList.toggle("hidden", state.mode !== "snapshot");
    $("btn-refresh-live").classList.toggle("hidden", state.mode === "snapshot");

    if (!state.map) return;
    var latlng = [fix.lat, fix.lon];
    if (!state.marker) {
      var icon = L.divIcon({
        className: "",
        html: '<div class="sl-marker"><div class="pulse"></div><div class="dot"></div></div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      state.marker = L.marker(latlng, { icon: icon, zIndexOffset: 500 }).addTo(state.map);
    } else {
      state.marker.setLatLng(latlng);
    }
    if (fix.accuracy_m && fix.accuracy_m > 0) {
      if (!state.accuracy) {
        state.accuracy = L.circle(latlng, {
          radius: fix.accuracy_m,
          color: "#56e8d6",
          weight: 1,
          fillColor: "#56e8d6",
          fillOpacity: 0.1,
        }).addTo(state.map);
      } else {
        state.accuracy.setLatLng(latlng);
        state.accuracy.setRadius(fix.accuracy_m);
      }
    }
    if (state.trailOn) {
      state.trailPts.push(latlng);
      if (state.trailPts.length > 500) state.trailPts.shift();
      if (!state.trail) {
        state.trail = L.polyline(state.trailPts, {
          color: "#56e8d6",
          weight: 3,
          opacity: 0.85,
        }).addTo(state.map);
      } else {
        state.trail.setLatLngs(state.trailPts);
      }
    }
    if (state.follow) {
      if (state.map.getZoom() < 5) state.map.setView(latlng, 16, { animate: true });
      else state.map.panTo(latlng, { animate: true });
    }
  }

  function initMap() {
    if (state.map) return;
    // Default view: world, until we have a fix
    state.map = L.map("map", {
      zoomControl: false,
      attributionControl: true,
    }).setView([20, 0], 2);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(state.map);
    state.map.on("dragstart", function () {
      state.follow = false;
    });
  }

  function stopTimer() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function startLoop(fn) {
    stopTimer();
    fn();
    state.timer = setInterval(fn, REFRESH_MS);
  }

  function openMapMode(mode) {
    state.mode = mode;
    state.follow = true;
    showSetup(false);
    initMap();
    setTimeout(function () {
      state.map.invalidateSize();
    }, 200);
  }

  async function refreshLive() {
    try {
      var fix = await fetchDishLocation();
      setBanner("", "", "");
      renderFix(fix);
    } catch (err) {
      var copy = errorCopy(err.kind, err.message);
      setBanner(copy.warn ? "warn" : "error", copy.title, copy.html);
    }
  }

  function startLive() {
    openMapMode("live");
    startLoop(refreshLive);
  }

  function startDemo() {
    openMapMode("demo");
    setBanner(
      "warn",
      "Demo mode",
      "<p>This is a simulated moving location so you can try the map. It is not from your dish.</p>"
    );
    startLoop(function () {
      renderFix(demoFix());
    });
  }

  function startSnapshot(fix) {
    openMapMode("snapshot");
    setBanner(
      "warn",
      "One-shot location from the Shortcut",
      "<p>This page is not talking to the dish directly. Tap <strong>Refresh</strong> to run the Shortcut again and get a new fix.</p>"
    );
    renderFix(fix);
    stopTimer();
  }

  async function tryDirectFromThisPage() {
    if (isHttpsPublicPage()) {
      var copy = errorCopy("mixed");
      setBanner("warn", copy.title, copy.html);
      showSetup(true);
      $("try-result").innerHTML =
        "<p><strong>Not attempted.</strong> This page is HTTPS, so iOS Safari would block HTTP calls to the dish as mixed content.</p>";
      return;
    }
    $("try-result").textContent = "Trying the dish at 192.168.100.1:9201…";
    try {
      var fix = await fetchDishLocation();
      startLive();
      renderFix(fix);
      showToast("Connected to your dish");
    } catch (err) {
      var copy = errorCopy(err.kind, err.message);
      $("try-result").innerHTML =
        "<p><strong>" + copy.title + "</strong></p>" + copy.html;
      setBanner(copy.warn ? "warn" : "error", copy.title, copy.html);
    }
  }

  function copyBookmarklet() {
    var code = bookmarkletCode();
    function done() {
      showToast("Bookmarklet copied");
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(fallback);
    } else fallback();
    function fallback() {
      var ta = $("bookmarklet-text");
      ta.classList.remove("hidden");
      ta.value = code;
      ta.focus();
      ta.select();
      try {
        document.execCommand("copy");
        done();
      } catch (e) {
        showToast("Select the text and copy it");
      }
    }
  }

  function goBackToSetup() {
    stopTimer();
    state.mode = "setup";
    setBanner("", "", "");
    showSetup(true);
  }

  function bind() {
    $("btn-copy-bookmarklet").addEventListener("click", copyBookmarklet);
    $("btn-demo").addEventListener("click", startDemo);
    $("btn-try").addEventListener("click", tryDirectFromThisPage);
    $("btn-open-dish").addEventListener("click", function () {
      location.href = "http://192.168.100.1/";
    });
    $("btn-recenter").addEventListener("click", function () {
      state.follow = true;
      if (state.lastFix && state.map) {
        state.map.setView([state.lastFix.lat, state.lastFix.lon], Math.max(state.map.getZoom(), 16));
      }
    });
    $("btn-trail").addEventListener("click", function () {
      state.trailOn = !state.trailOn;
      $("btn-trail").classList.toggle("on", state.trailOn);
      if (!state.trailOn && state.trail) {
        state.map.removeLayer(state.trail);
        state.trail = null;
        state.trailPts = [];
      } else if (state.trailOn && state.lastFix) {
        state.trailPts = [[state.lastFix.lat, state.lastFix.lon]];
      }
    });
    $("btn-refresh-live").addEventListener("click", function () {
      if (state.mode === "demo") renderFix(demoFix());
      else refreshLive();
    });
    $("btn-refresh-shortcut").addEventListener("click", function () {
      location.href = "shortcuts://run-shortcut?name=" + encodeURIComponent("Starlink Map");
    });
    $("btn-setup").addEventListener("click", goBackToSetup);
    $("bookmarklet-text").value = bookmarkletCode();
    $("shortcut-url-sample").textContent =
      new URL("index.html", location.href).href.split("#")[0] +
      "#grpc=PASTE_BASE64_HERE";
    $("grpc-b64").textContent = GET_LOCATION_B64;
  }

  function start(opts) {
    opts = opts || {};
    document.body.classList.add("app-lock");
    bind();

    var params = new URLSearchParams(location.search);
    if (params.get("demo") === "1" || params.get("demo") === "true") {
      startDemo();
      return;
    }

    try {
      var fromHash = parseHashPayload();
      if (fromHash) {
        startSnapshot(fromHash);
        return;
      }
    } catch (e) {
      showSetup(true);
      var copy = errorCopy("protocol", e.message);
      $("try-result").innerHTML = "<p><strong>The Shortcut data could not be parsed.</strong> " +
        escapeHtml(e.message) +
        "</p>";
      return;
    }

    if (opts.mode === "inject" || isDishOrigin()) {
      startLive();
      return;
    }

    showSetup(true);
  }

  global.StarlinkMap = {
    start: start,
    parseGetLocationResponse: parseGetLocationResponse,
    GET_LOCATION_FRAME: GET_LOCATION_FRAME,
    GET_LOCATION_B64: GET_LOCATION_B64,
    directoryOfScript: directoryOfScript,
    pageDirectory: pageDirectory,
    injectScriptUrl: injectScriptUrl,
    bookmarkletFor: bookmarkletFor,
    dishGrpcUrl: dishGrpcUrl,
  };
})(window);
