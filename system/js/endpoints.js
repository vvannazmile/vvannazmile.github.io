"use strict";

// ── Backend endpoints ──────────────────────────────────────────────────
// The two Apps Script projects (.documentation/api/) and what each serves:
//
//   data  data.gs  quotes, sync, tickets, legacy asset feed
//                  (quotes.js, ticket.js, legacy main.js feeds)
//   mod   mod.gs   word filter, taken usernames — open, no ticket
//                  (wordfilter.js)
//
// Catalogs (themes, banners, frames, gif packs, widgets, wrappers) come only
// from the local JSON files under /json via WS_LocalCatalogs below.
//
// This file loads before other system scripts, so they can read
// window.WS_ENDPOINTS and the local catalog loader.
//
window.WS_ENDPOINTS = Object.freeze({
  data: "https://script.google.com/macros/s/AKfycbwTLT4Hv7ThVJ2C4UlUyw7IJ7joif706yTLAkHMV5kFFHs2DBLTC9iw34YAL-BIbmwQ/exec",
  mod:  "https://script.google.com/macros/s/AKfycbyorR1RSI3-aYv91IIobUxMmNv8HKMyYvNKhwgR27AXetGROjkE_eYgBNyW5hwyPh_w/exec",
  // Public SQL (D1) library used for the homepage and DevBuild assets.
  // One exported JSON file ({ updated, items }) rebuilt by the ankom-api Worker
  // from D1 and served straight from R2, so opening a tab never reads D1.
  // main.js keeps its own copy for 3 hours (see loadLibrarySnapshot).
  library: "https://ws.ankomstudios.com/library/items.json",
  // Your Cloudflare Worker HTML-fetch endpoint used by "qwerty" assets.
  // This fetches the initial HTML document only; it is not a WebSocket relay.
  fetch: "https://ankom-url-api.ankomstudios.workers.dev/fetch?url=",
});

window.WS_LocalCatalogs = (() => {
  const files = Object.freeze({
    banners: "banners.json",
    frames: "frames.json",
    gifpacks: "gifpacks.json",
    themes: "themes.json",
    widgets: "widgets.json",
    wrappers: "wrappers.json",
  });
  const base = new URL("../json/", document.currentScript?.src || location.href);
  const pending = new Map();

  function load(type) {
    const file = files[type];
    if (!file) return Promise.reject(new Error(`Unknown local catalog: ${type}`));
    if (!pending.has(type)) {
      pending.set(type, fetch(new URL(file, base), { cache: "no-cache" }).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status} loading ${file}`);
        const rows = await response.json();
        if (!Array.isArray(rows)) throw new Error(`${file} must contain a JSON array`);
        return rows;
      }).catch((error) => {
        pending.delete(type);
        throw error;
      }));
    }
    return pending.get(type);
  }

  return Object.freeze({ load });
})();

// Temporary public-library transition: keep ticket APIs available, but don't
// require ticket onboarding to browse the public SQL asset library.
window.WS_TICKETS_ENABLED = false;

// ── General media (mediabaseWS) ────────────────────────────────────────
// Banners, profile pics, stickers and theme art live in their own repo,
// github.com/wannasmile4evr/mediabaseWS, not in this site:
//
//   assets/media/banners/         -> banners/<id>/splash.<ext>
//   assets/media/images/profile/  -> profile/
//   assets/media/stickers/        -> stickers/
//   assets/media/themes/          -> themes/
//   (new, never lived on this site)  frames/<id>/splash.<ext>, wrappers/<id>/splash.<ext>
//
// A sheet row or saved value may also just name the repo path directly
// ("banners/buni/splash.jpg", optionally with a "site:" prefix, which banner
// picks are saved with); those resolve against this repo too. Old flat
// banner names (banners/banner7.jpg) no longer exist there: the banners were
// renamed to per-id folders, so BannerWS rows must use the new paths.
//
// Sheet rows and browser caches can still hold old site paths, old repo URLs,
// or the former theme/gif-pack directories. Normalize those to this repo's
// current layout while leaving unrelated URLs alone.
window.WS_MEDIABASE = "https://raw.githubusercontent.com/wannasmile4evr/mediabaseWS/main/";

window.toMediabase = (() => {
  const host = location.host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const moved = new RegExp(
    String.raw`^(?:site:|(?:https?:)?//(?:wannasmile4evr\.github\.io\.?|vvannazmile\.github\.io\.?${host ? "|" + host : ""})/(?:[^?#]*?/)?|/|(?:\.\.?/)*)` +
    String.raw`(?:assets/)?media/(banners|stickers|themes|images/profile)/`, "i");
  const direct = /^(?:site:)?((?:banners|stickers|themes|profile|frames|wrappers|gif-packs)\/.+)$/i;
  const oldRepo = /^https?:\/\/raw\.githubusercontent\.com\/wannasmile4evr\/(?:wannabase|mediabaseWS)\/main\/(.*)$/i;
  const normalizePath = (path) => path
    .replace(/^themes\/([^/]+)\/system-media\//i, "themes/$1/")
    .replace(/^themes\/([^/]+)\/gif-states\//i, "gif-packs/$1/");

  return (url) => {
    if (typeof url !== "string") return url;
    const v = url.trim();
    const m = v.match(moved);
    if (m) {
      const dir = m[1].toLowerCase() === "images/profile" ? "profile" : m[1].toLowerCase();
      return window.WS_MEDIABASE + normalizePath(dir + "/" + v.slice(m[0].length));
    }
    const old = v.match(oldRepo);
    if (old) return window.WS_MEDIABASE + normalizePath(old[1]);
    const d = v.match(direct);
    return d ? window.WS_MEDIABASE + normalizePath(d[1]) : url;
  };
})();
