# Starlink Map

A phone-only live map of your Starlink dish’s location. It runs on **your iPhone and the dish**. There is no server in the middle, and no Python backend.

The setup page is a static site. Once GitHub Pages is enabled, it is hosted at:

**https://jonathansafer.github.io/alt-maps/**

The dish only answers on your local network, at `192.168.100.1`. A page on the public internet cannot read that location from iOS Safari (see [Why the setup page cannot call the dish itself](#why-the-setup-page-cannot-call-the-dish-itself)). The live map avoids that by running **inside the dish’s own page**.

> These flows were built from public protocol research. They were **not tested against a real dish**. Treat the first successful fix on your phone as the real confirmation.

## Live map bookmark (use this)

This is the continuously updating map. It polls the dish about every 10 seconds.

1. On the iPhone, open [https://jonathansafer.github.io/alt-maps/](https://jonathansafer.github.io/alt-maps/) in **Safari** and tap **Copy bookmarklet**.
2. Bookmark any page (Share → **Add Bookmark**). Open the Bookmarks list, tap **Edit**, open that bookmark, and paste the copied text into the **URL / Address** field. Name it **Starlink Map**.
3. Connect the iPhone to **Starlink Wi‑Fi**.
4. In the Starlink app, open **Settings → Advanced → Debug Data** and turn on **Allow access on local network** in the Starlink Location section. (The exact labels move around. It is only in the mobile app, not the browser app.)
5. In Safari, go to [http://192.168.100.1](http://192.168.100.1) (or [http://dishy.starlink.com](http://dishy.starlink.com) if you use a Starlink router and that name works).
6. Tap the **Starlink Map** bookmark. The map replaces the dish page and starts polling for a fix.

The bookmarklet is a short script. It loads `inject.js` from **this page’s own address** (`https://jonathansafer.github.io/alt-maps/inject.js` when you copied it from the hosted setup page). That keeps the `/alt-maps/` subpath. `inject.js` then loads the map files from the same directory and calls the dish.

On Starlink’s own router the phone can usually reach `192.168.100.1` with no extra route. A third-party router still has to be able to reach that address.

**Important caveat:** As of May 2026, Starlink removed location data from this local API for most residential plans. Public reporting says some **Priority** plans still have it, and on some newer dishes the toggle has disappeared from the app. If the map connects but you get no coordinates, this is the likely reason.

Add to Home Screen is optional and a little awkward here: Share → **Add to Home Screen** while you are on `http://192.168.100.1` saves the *dish page*, not the injected map. Opening the icon later still works, but you will need to tap the bookmark again.

### Why loading the script from GitHub Pages is allowed

The dish page is plain HTTP. `inject.js` is HTTPS. That direction is allowed: mixed content is an **HTTPS page loading HTTP resources**, which Safari blocks. An HTTP page loading an HTTPS script, stylesheet, or image is not mixed content.

The bookmarklet inserts a classic `<script src="https://…/inject.js">` with no `crossorigin` attribute, so the load is not subject to CORS. The same is true of the CSS and the follow-up scripts (`app.js`, Leaflet) that `inject.js` adds, and of the map-marker images those stylesheets point at. OpenStreetMap tiles are HTTPS images on an HTTP page, which Safari also allows.

Nothing in that chain is a `fetch()` from the GitHub Pages origin to the dish. The script runs in the dish page, so its origin is the dish page:

- On `http://192.168.100.1`, it POSTs to `http://192.168.100.1:9201/SpaceX.API.Device.Device/Handle`.
- On `http://dishy.starlink.com`, it POSTs to `http://dishy.starlink.com:9201/…/Handle` (same host, port 9201). That matches the dish’s own web UI, which calls `location.hostname` on port 9201. Port 80 and port 9201 are different origins, so the browser still sends a CORS preflight, and the dish already allows those two page origins — that is how its own UI works.

Two things can still stop it, and neither was tested here (there is no dish on this network):

- A **Content-Security-Policy** on the dish page that does not allow scripts from `jonathansafer.github.io`. If the bookmark does nothing, that is the first thing to suspect.
- Location simply not being exposed on your plan (see the caveat above).

This project does not use DNS rebinding, Referer stripping, or other tricks that have been written up as ways to bypass the dish’s cross-origin policy.

## iOS Shortcut (one-tap snapshot)

Shortcuts can POST to the dish without Safari’s CORS rules. This hands the result to the setup page as **one fix**. It does not auto-refresh every 10 seconds. Use the bookmark above for live tracking.

1. In the **Shortcuts** app, create a shortcut named exactly `Starlink Map`.
2. Add **Base64 Decode**, and set the input text to:

   ```
   AAAAAAPKPwA=
   ```

   That is the framed `get_location` request.
3. Add **Get Contents of URL**:
   - URL: `http://192.168.100.1:9201/SpaceX.API.Device.Device/Handle`
   - Method: **POST**
   - Headers: `Content-Type` = `application/grpc-web+proto`, and `X-Grpc-Web` = `1`
   - Request Body: **File**, using the Base64 Decode result
4. Add **Base64 Encode** on the URL’s contents.
5. Add **Open URLs**. The URL should be the setup page plus `#grpc=` and the encoded response:

   ```
   https://jonathansafer.github.io/alt-maps/index.html#grpc=THE_BASE64_RESPONSE
   ```

6. Add the Shortcut to your Home Screen, or add the setup page to the Home Screen (Share → **Add to Home Screen**) and use it as the landing page.

The in-map **Refresh** button re-runs a shortcut named `Starlink Map`.

## Demo preview

On the setup page, tap **Open demo map**, or open [https://jonathansafer.github.io/alt-maps/?demo=1](https://jonathansafer.github.io/alt-maps/?demo=1). You’ll see a simulated moving location, a recenter button, and an optional breadcrumb trail. No dish is contacted.

## Why the setup page cannot call the dish itself

The dish’s browser API is gRPC-web:

```
POST http://192.168.100.1:9201/SpaceX.API.Device.Device/Handle
Content-Type: application/grpc-web+proto
X-Grpc-Web: 1
body: binary protobuf Request { get_location {} }
```

Several independent constraints get in the way of a page you simply open from the internet:

| Issue | What it means | Confidence |
| --- | --- | --- |
| **CORS** | The `application/grpc-web+proto` content type is not “simple,” so Safari sends an OPTIONS preflight. Public write-ups of the dish API (and SpaceX’s note on CVE-2025-67780) say **cross-origin policy is enforced on port 9201** and that the dish does not authorize arbitrary sites. The official web UI works because it is served from `http://192.168.100.1` or `http://dishy.starlink.com`, origins the dish already expects. Community projects such as [open-dishy](https://github.com/iam-TJ/open-dishy) had to **proxy** 9201 from a local computer and spoof those origins — which needs a computer, so it is out of scope here. | Strong, from public sources. **Not verified on your dish.** |
| **Mixed content** | The dish is **HTTP only**. A page hosted on HTTPS (GitHub Pages, Netlify, almost every free host) cannot `fetch()` `http://192.168.100.1` in iOS Safari. Safari also does **not** support the newer “Local Network Access” / `targetAddressSpace` escape that Chrome is adding. | Confirmed for current Safari generally. |
| **Private / local network permission** | Apple documents that **Safari itself is exempt** from the Local Network permission prompt that apps get (TN3179). Still, the phone must be able to route to `192.168.100.1`. | Documented by Apple; routing on your LAN is installation-specific. |

A “Try connecting now” button is on the setup page so you can see Safari’s result. On the HTTPS setup page it does not even attempt the call: iOS Safari would block it as mixed content.

## If Safari still can’t reach it

1. Confirm you are on Starlink Wi‑Fi and can open [http://192.168.100.1](http://192.168.100.1) in Safari at all.
2. Confirm the location-sharing toggle (or that your plan still exposes location).
3. Use the **Shortcuts** method. It does not depend on CORS.
4. If the bookmarklet is blocked (for example by CSP), the remaining options are a **native iOS app** (no CORS, but you would need an Apple Developer account / TestFlight / a computer to sideload) or running a tiny local helper on a Mac, PC, or Raspberry Pi.
5. There is no supported way to install a custom web app *onto the dish itself* so that `http://192.168.100.1` would serve this map.

## What’s in this repo

```
public/                   Site root uploaded to GitHub Pages
  index.html              Setup page + map UI
  app.js                  Map, demo mode, hand-encoded gRPC-web client
  app.css                 Mobile-first, safe-area, large touch targets
  inject.js               Bookmarklet payload; takes over the dish page
  manifest.webmanifest    Relative start_url and scope (works under /alt-maps/)
  icons/                  Apple touch icon + PWA icons
  vendor/leaflet/         Vendored Leaflet 1.9.4 (no API key; OpenStreetMap tiles)
tests/decode_test.js      Request frame + response decode, no dish required
.github/workflows/pages.yml
screenshots/              Reference shots of the setup page and the map
```

Asset URLs in `index.html` are relative (`app.js`, not `/app.js`). The manifest `start_url` is `./index.html` and `scope` is `./`, both resolved against the manifest’s own URL, so they stay inside `/alt-maps/` on GitHub Pages.

## How location retrieval works

- Endpoint: `POST http://<dish-host>:9201/SpaceX.API.Device.Device/Handle`
  - `<dish-host>` is `192.168.100.1` on that page, or `dishy.starlink.com` when the map was injected there.
- Protocol: gRPC-web (`application/grpc-web+proto`), not the raw gRPC port `9200` (which browsers cannot speak).
- Request headers match the dish’s own UI and published captures: `Content-Type: application/grpc-web+proto`, `X-Grpc-Web: 1`, and `X-User-Agent: grpc-web-javascript/0.1`.
- Request protobuf: `Request.get_location` is field **1017**, a `GetLocationRequest`. Published `device.proto` gives that message an optional `source` enum (field 1). The value used here is the empty message (`{"get_location":{}}`), which is what `grpcurl` examples send; proto3 omits the default `source`. The framed bytes are `00 00 00 00 03 ca 3f 00` (base64 `AAAAAAPKPwA=`).
- Response: `Response.get_location` is also field **1017**. `GetLocationResponse` is `lla` (field 1), `source` (field 3), `sigma_m` (field 4), `horizontal_speed_mps` (field 5), `vertical_speed_mps` (field 6). `LLAPosition` is `lat` / `lon` / `alt` as doubles (fields 1, 2, 3). `Response.status` is field 2 (`code` = 1, `message` = 2). `api_version` is field 3 and is ignored.
- `PERMISSION_DENIED` (gRPC 7), either as a gRPC-web trailer or as `Response.status.code`, or an empty `lla`, is treated as “location access not enabled.”
- Field numbers come from published `device.proto` snapshots (community `star-debug`, `starlink-client`, `starlink-grpc-golang`). Firmware can change them.

Check the codec without a dish:

```bash
node tests/decode_test.js
```

## Publishing

`.github/workflows/pages.yml` deploys the **contents** of `public/` to GitHub Pages on every push to `main` (`actions/configure-pages` with `enablement: true`, `actions/upload-pages-artifact`, `actions/deploy-pages`).

Pages is not turned on by the default Actions token. Before the first deploy can succeed, enable it once:

**Settings → Pages → Build and deployment → Source: GitHub Actions**

`enablement: true` tries to create that site, but the workflow’s `GITHUB_TOKEN` is not allowed to (it would need a separate admin token). If the Actions run stops with “Get Pages site failed” or “Create Pages site failed”, the Settings step above is the fix. Re-run the workflow after saving it.

The published URL is `https://jonathansafer.github.io/alt-maps/`.

## Preview the UI on a computer (optional)

You do not need this for the iPhone workflow. It is only for looking at the static files. It is not a backend and it is not deployed.

From a parent directory, so the site is served on the same `/alt-maps/` subpath GitHub Pages uses:

```bash
mkdir -p /tmp/alt-maps-preview
ln -s "$PWD/public" /tmp/alt-maps-preview/alt-maps
python3 -m http.server 8080 --directory /tmp/alt-maps-preview
```

Then open [http://127.0.0.1:8080/alt-maps/?demo=1](http://127.0.0.1:8080/alt-maps/?demo=1). Copy the bookmarklet on that origin if you want to confirm it points at `http://127.0.0.1:8080/alt-maps/inject.js`.

## License and credits

Map rendering is [Leaflet](https://leafletjs.com/) with tiles from [OpenStreetMap](https://www.openstreetmap.org/copyright). The Starlink gRPC/gRPC-web API is unofficial and can change without notice.
