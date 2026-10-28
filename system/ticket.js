"use strict";

// ── Access tickets ─────────────────────────────────────────────────────
// Nothing is fetched from the Apps Script backend until this browser holds
// an approved ticket from the TicketApprovalWS sheet. The server enforces it
// (every feed except ?type=build / ?type=ticket needs &ticket=<approved id>,
// see .documentation/api/data.gs).
//
// This file is the ticket *state*: storage, the request/status calls, and
// WS_Ticket.ready, which every GS fetch awaits (bustCache() in utils.js adds
// &ticket=<id>&key=<key> to GS URLs).
//
// Every ticket has a secret key (24 random chars) issued with it. The server
// only accepts the id together with its key, so the id on its own (shown in
// the ☰ menu) is safe to share, and guessing ids gets nowhere. The key never
// appears on screen: it lives in localStorage and in the exported data file
// (ExportData.ws), which is the only way to bring a ticket to another
// browser — there's no "type your ticket id" box. Tickets from before keys
// existed (blank Key cell) still work by id alone. The *screens* live in
// the tutorial (tutorial.js).
//
// USERNAME vs NICKNAME: the ticket is created under a USERNAME — unique
// (the server refuses anything too close to an existing one), 3-20 of
// A-Z a-z 0-9 _ . -, and permanent: it's the ticket's Name in the sheet and
// never changes. The NICKNAME is just an optional display name (profile.js)
// set afterwards; with none, the username is shown. The username is kept in
// localStorage ws_username and travels with the ticket in the data file.
//
// One ticket per person: requests carry a random per-browser client id (the
// server hands a repeat request the same ticket back and refuses a name
// that already has one), and once this browser has asked (ws_ticket_requested)
// the tutorial never offers the request form again. New tickets are
// approved on the spot by the server while the ticket count is below the
// highest milestone in column H of TicketApprovalWS (see data.gs). (Bad words in the name or
// reason are caught in the browser before sending — see wordfilter.js.)
//
// Load right after utils.js and before anything that fetches.
//
// window.WS_Ticket = {
//   ready (Promise), id(), status(), approved(), asked(), withTicket(url),
//   lineage() -> { id, name } of the ticket this browser held before a "new ticket"
//                reset (or the current one), sent as `parent` with the next request
//   username() -> this ticket's username ("" if unknown, e.g. pre-username tickets)
//   request({ name, reason, pass, role, blocker }) -> { ok, ticket, key, name, status }
//                              | { ok:false, code:"name_taken"|"bad_name"|"bad_reason", error }
//   (`reason` is "grade|name|role|paragraph" — built by the tutorial; the
//   form's flip card is ticketcard.js. `pass` goes as `passhash`.)
//   info() -> true/false: are new tickets still auto-approved? (null if unknown)
//   cap()  -> the current auto-approve limit (the highest milestone in the
//             TicketApprovalWS sheet), or null if unknown; set by info()
//   check() -> "approved" | "pending" | "denied" | "needspass" | "unknown"
//     ("needspass": approved, but made before passwords existed, so it has
//     none yet and the server refuses it until setPassword() is done)
//     (Status cells like "rejected", "banned" or "no" count as denied;
//     any other unrecognised word as pending. See normalize().)
//   verify(id, key) -> same, for a ticket from a data file; stores nothing
//   setPassword(pass) -> { ok:true } | { ok:false, code:"bad_pass"|"ticket"|"has_pass", error }
//   revoke(status) -> new ready promise (fires "ws:ticket-gate")
// }
// Fires "ws:ticket-change" on document whenever the id/status changes.
(() => {
  const API_URL    = window.WS_ENDPOINTS.data;   // endpoints.js (DATA issues tickets)
  const ID_KEY     = "ws_ticket_id";
  const SECRET_KEY = "ws_ticket_key";       // the ticket's secret key (never shown)
  const STATUS_KEY = "ws_ticket_status";
  const CLIENT_KEY = "ws_ticket_client";    // random per-browser id sent with the request
  const ASKED_KEY  = "ws_ticket_requested"; // "1" once this browser has sent its one request
  const USER_KEY   = "ws_username";         // the ticket's permanent username
  const LINEAGE_KEY = "ws_ticket_lineage";  // { id, name } of the last ticket this browser held; survives "new ticket" resets (data.js)
  const BACKUP_KEY = "ws_ticket_backup";    // last wiped ticket {id,key,username,at}; see revoke()

  const read  = (k) => { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } };
  const write = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (_) {} };

  const id       = () => read(ID_KEY);
  const status   = () => read(STATUS_KEY);
  const secret   = () => read(SECRET_KEY);
  const approved = () => !!id() && status() === "approved";
  const asked    = () => read(ASKED_KEY) === "1";
  const username = () => read(USER_KEY);
  // The previous ticket, if this browser started over (id + name only, never the key).
  const lineage  = () => { try { const o = JSON.parse(localStorage.getItem(LINEAGE_KEY) || "null"); return o && o.id ? { id: String(o.id), name: String(o.name || "") } : null; } catch (_) { return null; } };

  let resolveReady;
  const newReady = () => new Promise((r) => { resolveReady = r; });

  function changed() {
    document.dispatchEvent(new CustomEvent("ws:ticket-change", { detail: { id: id(), status: status() } }));
  }

  function setState(ticketId, st, key) {
    if (ticketId !== undefined) write(ID_KEY, ticketId);
    if (key !== undefined) write(SECRET_KEY, key);
    write(STATUS_KEY, st);
    if (st === "approved") resolveReady();
    changed();
  }

  function clientId() {
    let c = read(CLIENT_KEY);
    if (!c) {
      c = crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      write(CLIENT_KEY, c);
    }
    return c;
  }

  function withTicket(url) {
    const t = id();
    if (!t || !/script\.google(usercontent)?\.com/.test(url) || /[?&]ticket=/.test(url)) return url;
    const k = secret();
    return `${url}${url.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(t)}${k ? `&key=${encodeURIComponent(k)}` : ""}`;
  }

  // Every call has a deadline: a request that never answers (Apps Script
  // cold start, a dropped connection) used to leave the "One sec…" card up
  // for good. On timeout this throws, and callers already treat a throw as
  // "couldn't reach the server".
  async function api(params, body, timeoutMs = 20000) {
    const qs  = new URLSearchParams({ ...params, _: Date.now() }).toString();
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // No Content-Type header on the POST: a text/plain body is a "simple"
      // request, so there's no CORS preflight (Apps Script can't answer one).
      const res = await fetch(`${API_URL}?${qs}`, body
        ? { method: "POST", body: JSON.stringify(body), cache: "no-store", signal: ctrl.signal }
        : { cache: "no-store", signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (err?.name === "AbortError") throw new Error("The server took too long to answer.");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // `name` is the username. Throws on network trouble; a taken or badly
  // formed username comes back as { ok:false, code }.
  // The ticket form also sends `role`, `blocker` and `pass`. The password is
  // never stored here and never sent as typed: it goes as a SHA-256 hash
  // (`passhash`) salted with the username. The server has to be taught to
  // keep these (data.gs); until then it ignores the extra fields.
  async function hashPass(name, pass) {
    if (!pass) return "";
    if (!window.crypto?.subtle) throw new Error("Passwords need a secure (https) connection.");
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ws1:${String(name).toLowerCase()}:${pass}`));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function request({ name, reason, pass, role, blocker }) {
    const passhash = await hashPass(name, pass);
    const body = { type: "ticket", name, reason, client: clientId() };
    if (role) body.role = role;
    if (blocker) body.blocker = blocker;
    if (passhash) body.passhash = passhash;
    // Started over from an older ticket: say which, so the server logs this
    // username in the same account tree ("old|new|newer").
    const from = lineage();
    if (from && from.id !== id()) body.parent = from.id;
    const res = await api({}, body, 45000);
    if (res?.code === "name_taken" || res?.code === "bad_name" || res?.code === "bad_reason") return res;
    if (!res?.ok || !res.ticket) throw new Error(res?.error || "No ticket came back.");
    write(ASKED_KEY, "1");
    try { localStorage.setItem(LINEAGE_KEY, JSON.stringify({ id: res.ticket, name: res.name || name, at: new Date().toISOString() })); } catch (_) {}
    // The server's copy wins (a repeat request gets the original username).
    write(USER_KEY, res.name || name);
    // res.existing: this browser had already asked — same ticket, no new row.
    res.status = normalize(res.status);
    setState(res.ticket, res.status === "approved" || res.status === "denied" || res.status === "needspass" ? res.status : "pending", res.key || "");
    return res;
  }

  // Gives an approved ticket that has no password one (the server only allows
  // that for a ticket with its own key). Sent as a hash, like request().
  async function setPassword(pass) {
    if (!id() || !secret()) return { ok: false, code: "ticket", error: "There's no ticket to put a password on." };
    const passhash = await hashPass(username(), pass);
    const res = await api({}, { type: "setpass", ticket: id(), key: secret(), passhash }, 30000);
    if (res?.ok) { setState(undefined, "approved"); return res; }
    if (res?.code === "bad_pass" || res?.code === "ticket" || res?.code === "has_pass") return res;
    throw new Error(res?.error || "The password wasn't saved.");
  }

  // Whether a new ticket would be approved on the spot (the backend decides:
  // tickets get in while the count is below the highest milestone in column H
  // of TicketApprovalWS). The tutorial uses it to pick the order: profile
  // first while it's true, ticket first once it isn't. null = couldn't tell
  // (old backend/offline). The limit itself is kept for cap().
  let autoCap = null;
  async function info() {
    try {
      const res = await api({ type: "ticketinfo" }, undefined, 8000);
      autoCap = Number(res?.milestone) > 0 ? Number(res.milestone) : null;
      return typeof res?.autoApprove === "boolean" ? res.autoApprove : null;
    } catch (_) {
      return null;
    }
  }
  const cap = () => autoCap;

  // The server passes a ticket's Status cell through as typed (only
  // approved/accepted are turned into "approved"), so the words are sorted
  // here: any of DENY_WORDS means denied, "unknown"/"missing" (no such
  // ticket) stay as they are, and anything else is still waiting.
  const DENY_WORDS = new Set([
    "denied", "deny", "rejected", "reject", "declined", "decline", "refused", "refuse",
    "banned", "ban", "blocked", "block", "revoked", "revoke", "removed", "no",
  ]);
  function normalize(st) {
    const s = String(st == null ? "" : st).trim().toLowerCase();
    if (s === "approved" || s === "accepted") return "approved";
    if (s === "needs_password" || s === "needspass") return "needspass";
    if (s === "unknown" || s === "missing") return s;
    if (DENY_WORDS.has(s)) return "denied";
    return "pending";
  }

  // `strict`: a reply with no status at all (an Apps Script error/quota
  // object, a half-loaded response) is treated as "couldn't reach the
  // server" and throws, instead of being read as "no such ticket". Used by
  // the background re-check, where "unknown" wipes the saved account.
  async function lookup(ticketId, key, strict) {
    const res = await api({ type: "ticket", id: ticketId, ...(key ? { key } : {}) });
    if (strict && !res?.status) throw new Error(res?.error || "No ticket status came back.");
    return res?.status ? normalize(res.status) : "unknown";
  }

  async function check() {
    if (!id()) return "unknown";
    const st = await lookup(id(), secret(), true);
    if (st === "approved" || st === "pending" || st === "denied" || st === "needspass") setState(undefined, st);
    return st;
  }

  // A ticket from an uploaded data file, checked before anything from the
  // file is saved. Wrong key and unknown id look identical ("unknown").
  function verify(ticketId, key) {
    return ticketId ? lookup(String(ticketId).trim(), String(key || "").trim()) : Promise.resolve("unknown");
  }

  // The server refused a stored "approved" ticket (revoked/removed in the
  // sheet): forget the approval, hand out a new promise, and ask the
  // tutorial to put its ticket screen back up.
  function revoke(st) {
    st = normalize(st);
    if (st === "unknown" || st === "missing") {
      // Keep a recovery copy so a wrongly-reported "unknown" is never a
      // permanent loss (the key is the only way back into the ticket).
      try {
        if (id()) localStorage.setItem(BACKUP_KEY, JSON.stringify({ id: id(), key: secret(), username: username(), at: new Date().toISOString() }));
      } catch (_) {}
      write(ID_KEY, ""); write(STATUS_KEY, ""); write(SECRET_KEY, ""); write(USER_KEY, "");
    }
    else write(STATUS_KEY, st === "denied" ? "denied" : st === "needspass" ? "needspass" : "pending");
    window.WS_Ticket.ready = newReady();
    changed();
    document.dispatchEvent(new CustomEvent("ws:ticket-gate"));
    return window.WS_Ticket.ready;
  }

  // ── ☰ menu: nickname on the left, ticket id on the right (#dashIdRow) ──
  function paintDashboard() {
    const el = document.getElementById("dashTicketId");
    if (!el) return;
    const t = id();
    el.textContent = t || "no ticket";
    el.classList.toggle("is-empty", !t);
    el.title = !t ? "No access ticket yet"
             : approved() ? "Your ticket id (click to copy)"
             : `Your ticket id: ${status() || "pending"} (click to copy)`;
  }

  document.addEventListener("ws:ticket-change", paintDashboard);
  document.addEventListener("DOMContentLoaded", () => {
    paintDashboard();
    const idEl = document.getElementById("dashTicketId");
    idEl?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); idEl.click(); }
    });
    idEl?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation(); // keep the ☰ menu open
      const t = id();
      if (!t) return;
      navigator.clipboard?.writeText(t).then(() => {
        if (typeof showToast === "function") showToast("🎟️ Ticket id copied");
      }).catch(() => {});
    });
  });

  const ready = newReady();
  if (approved()) resolveReady();

  // Puts back the ticket revoke() wiped (if any) and re-checks it with the
  // server. Console: await WS_Ticket.restore()
  async function restore() {
    let b; try { b = JSON.parse(localStorage.getItem(BACKUP_KEY) || "null"); } catch (_) { b = null; }
    if (!b?.id) return "none";
    const st = await lookup(b.id, b.key, true);
    if (st === "approved" || st === "pending" || st === "denied" || st === "needspass") {
      write(USER_KEY, b.username || "");
      setState(b.id, st, b.key || "");
      write(BACKUP_KEY, "");
    }
    return st;
  }

  window.WS_Ticket = { ready, id, status, approved, asked, username, withTicket, request, setPassword, lineage, info, cap, check, verify, revoke, restore, normalize };
})();