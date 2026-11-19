const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const code = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const sandbox = {
  window: {},
  console,
  Uint8Array,
  DataView,
  TextDecoder,
  URL,
  URLSearchParams,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.runInNewContext(code, sandbox);
const api = sandbox.window.StarlinkMap;

assert.strictEqual(api.GET_LOCATION_B64, "AAAAAAPKPwA=");
assert.deepStrictEqual(
  Array.from(api.GET_LOCATION_FRAME),
  [0x00, 0x00, 0x00, 0x00, 0x03, 0xca, 0x3f, 0x00]
);

function varint(n) {
  const out = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}
function encDouble(field, value) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value);
  return Buffer.concat([varint((field << 3) | 1), buf]);
}
function encMsg(field, data) {
  return Buffer.concat([varint((field << 3) | 2), varint(data.length), data]);
}
function encVarint(field, value) {
  return Buffer.concat([varint((field << 3) | 0), varint(value)]);
}
function frame(payload) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

const lat = 34.0522, lon = -118.2437, alt = 86.5, src = 6, sigma = 0.93;
const lla = Buffer.concat([encDouble(1, lat), encDouble(2, lon), encDouble(3, alt)]);
const loc = Buffer.concat([encMsg(1, lla), encVarint(3, src), encDouble(4, sigma)]);
const resp = encMsg(1017, loc);
const framed = frame(resp);

const parsed = api.parseGetLocationResponse(framed);
assert.ok(Math.abs(parsed.lat - lat) < 1e-9, "lat");
assert.ok(Math.abs(parsed.lon - lon) < 1e-9, "lon");
assert.ok(Math.abs(parsed.altitude - alt) < 1e-9, "alt");
assert.strictEqual(parsed.source, "GNC_FUSED");
assert.ok(Math.abs(parsed.accuracy_m - sigma) < 1e-9, "sigma");

const trailBody = Buffer.from("grpc-status: 7\r\ngrpc-message: not enabled\r\n");
const trail = Buffer.alloc(5 + trailBody.length);
trail[0] = 0x80;
trail.writeUInt32BE(trailBody.length, 1);
trailBody.copy(trail, 5);
let denied = false;
try {
  api.parseGetLocationResponse(trail);
} catch (e) {
  denied = e.kind === "disabled";
}
assert.ok(denied, "permission denied classified");

// A real Handle response also carries an empty Status (field 2), api_version
// (field 3), and a grpc-status: 0 trailer frame. Speeds are fields 5 and 6.
const hSpeed = 0.2810645990860038;
const vSpeed = 0.011201696382552598;
const locFull = Buffer.concat([
  encMsg(1, lla),
  encVarint(3, src),
  encDouble(4, sigma),
  encDouble(5, hSpeed),
  encDouble(6, vSpeed),
]);
const envelope = Buffer.concat([
  encMsg(2, Buffer.alloc(0)),
  encVarint(3, 42),
  encMsg(1017, locFull),
]);
const trailOkBody = Buffer.from("grpc-status: 0\r\n");
const trailOk = Buffer.alloc(5 + trailOkBody.length);
trailOk[0] = 0x80;
trailOk.writeUInt32BE(trailOkBody.length, 1);
trailOkBody.copy(trailOk, 5);
const withTrailer = api.parseGetLocationResponse(Buffer.concat([frame(envelope), trailOk]));
assert.ok(Math.abs(withTrailer.lat - lat) < 1e-9, "envelope lat");
assert.strictEqual(withTrailer.source, "GNC_FUSED");
assert.ok(Math.abs(withTrailer.horizontal_speed_mps - hSpeed) < 1e-9, "hspeed");
assert.ok(Math.abs(withTrailer.vertical_speed_mps - vSpeed) < 1e-9, "vspeed");

// Application status inside Response.status (code = 1, message = 2), not only trailers.
const statusDenied = Buffer.concat([
  encVarint(1, 7),
  encMsg(2, Buffer.from("not enabled")),
]);
let innerDenied = false;
try {
  api.parseGetLocationResponse(frame(encMsg(2, statusDenied)));
} catch (e) {
  innerDenied = e.kind === "disabled";
}
assert.ok(innerDenied, "inner status permission denied");

const pagesDir = "https://jonathansafer.github.io/alt-maps/";
const pagesIndex = pagesDir + "index.html";
assert.strictEqual(api.pageDirectory(pagesDir), pagesDir);
assert.strictEqual(api.pageDirectory(pagesIndex), pagesDir);
assert.strictEqual(api.pageDirectory(pagesIndex + "?demo=1"), pagesDir);
assert.strictEqual(api.pageDirectory("https://jonathansafer.github.io/alt-maps"), pagesDir);
assert.strictEqual(api.injectScriptUrl(pagesIndex), pagesDir + "inject.js");
assert.strictEqual(api.injectScriptUrl(pagesDir), pagesDir + "inject.js");
assert.strictEqual(
  api.injectScriptUrl(pagesIndex + "?demo=1", pagesDir + "app.js"),
  pagesDir + "inject.js"
);
assert.strictEqual(
  api.directoryOfScript(pagesDir + "inject.js?t=123"),
  pagesDir
);
const bookmarklet = api.bookmarkletFor(pagesDir + "inject.js");
assert.ok(bookmarklet.startsWith("javascript:(function(){"), "bookmarklet scheme");
assert.ok(bookmarklet.includes(pagesDir + "inject.js?t="), "bookmarklet keeps subpath");
assert.ok(!bookmarklet.includes("'/inject.js"), "bookmarklet is not site-root absolute");

sandbox.location = { hostname: "192.168.100.1", protocol: "http:" };
assert.strictEqual(
  api.dishGrpcUrl(),
  "http://192.168.100.1:9201/SpaceX.API.Device.Device/Handle"
);
sandbox.location = { hostname: "dishy.starlink.com", protocol: "http:" };
assert.strictEqual(
  api.dishGrpcUrl(),
  "http://dishy.starlink.com:9201/SpaceX.API.Device.Device/Handle"
);
sandbox.location = { hostname: "jonathansafer.github.io", protocol: "https:" };
assert.strictEqual(
  api.dishGrpcUrl(),
  "http://192.168.100.1:9201/SpaceX.API.Device.Device/Handle"
);

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../public/manifest.webmanifest"), "utf8")
);
assert.strictEqual(manifest.start_url, "./index.html");
assert.strictEqual(manifest.scope, "./");
for (const icon of manifest.icons) {
  assert.ok(!icon.src.startsWith("/"), "manifest icon is relative: " + icon.src);
}

const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
assert.ok(!/\s(?:src|href)="\//.test(html), "index.html assets are relative");

console.log("decode_test: ok");
