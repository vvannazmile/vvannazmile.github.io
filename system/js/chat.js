"use strict";

// ── WannaChat ──────────────────────────────────────────────────────────
// Friends + direct messages for people who already have an access ticket.
//
//  • No login of its own and no exported data file: the page reads the
//    ticket this browser already holds (ticket.js: ws_ticket_id / key /
//    status / ws_username) and the Apps Script works out the real username
//    from that ticket, so nobody can chat as somebody else.
//  • Talks only to the DATA Apps Script (window.WS_ENDPOINTS.data, see
//    data.gs "WannaChat"): GET ?type=chat to read, POST { type:"chat" } to
//    act. No websocket; the page polls, and an idle poll is a tiny cached
//    answer ("unchanged"). The optional websocket worker lives in
//    documentation/websocket/ and is not used here.
//  • Friend requests: send → they Accept (or Decline) → then you can chat.
//    The newest 60 messages per friendship are kept; older ones are deleted
//    by the server as new ones arrive.
//  • msgcore.js (WS_Msg) is shared with the rest of the site. This page hands
//    it every poll answer; in return it supplies profile pictures and display
//    names, the real "is typing" state (and the column-C typing quotes),
//    unread/seen bookkeeping and the notification cards. #with=<username> in
//    the address opens that conversation (that's where a notification click
//    lands).
(() => {
  const $ = (id) => document.getElementById(id);
  const API = window.WS_ENDPOINTS && window.WS_ENDPOINTS.data;
  const M = window.WS_Msg || null;        // optional: the page still works as plain chat without it

  const K = { id: "ws_ticket_id", key: "ws_ticket_key", status: "ws_ticket_status", user: "ws_username", seen: "ws_chat_seen" };
  const read = (k) => { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } };
  const NAME_RE  = /^[a-z0-9][a-z0-9_.\-]{2,19}$/;
  const MAX_TEXT = 500;
  const POLL_MS  = 4000;      // tab in front (short, so "typing" shows up while it's happening)
  const SLOW_MS  = 30000;     // tab hidden
  const MAX_BACKOFF = 60000;
  const TYPING_PING_MS = 3000;   // how often "I'm typing" is sent while a draft is being written
  const GROUP_GAP_MS = 5 * 60000; // messages from one person closer than this share one avatar/name

  const state = {
    me: "", friends: [], active: "", messages: [], rev: "", max: 60,
    loading: false, again: false, fails: 0, timer: 0, dead: false, sending: false,
    wanted: "",             // #with=<name> still waiting for the friend list
    lastPing: 0,
  };

  const toast = (m) => (window.showToast ? window.showToast(m, 3200) : console.log(m));
  const cleanName = (v) => String(v || "").trim().replace(/^@/, "").toLowerCase();
  const visibleNow = () => document.visibilityState === "visible" && document.hasFocus();

  // Same small DOM helper everywhere; all user text goes in through
  // textContent, never innerHTML.
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const k in props || {}) {
      if (k === "class") n.className = props[k];
      else if (k === "text") n.textContent = props[k];
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), props[k]);
      else if (props[k] !== false && props[k] != null) n.setAttribute(k, props[k] === true ? "" : props[k]);
    }
    for (const c of kids) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  const icon = (cls) => el("i", { class: cls, "aria-hidden": "true" });

  // ── names and pictures (WS_Msg when present) ──────────────────────────
  const shown = (name) => (M ? M.displayName(name) : name);
  function avatar(name, cls) {
    if (M) return M.avatar(name, cls);
    return el("span", { class: "ws-av" + (cls ? " " + cls : "") }, String(name || "?").charAt(0).toUpperCase());
  }
  // A name that follows later profile updates: refreshNames() rewrites it in place.
  const nameTag = (tag, user, cls) => el(tag, cls ? { class: cls, "data-ws-name": user, text: shown(user) } : { "data-ws-name": user, text: shown(user) });
  function refreshNames() {
    document.querySelectorAll("[data-ws-name]").forEach((n) => {
      const t = shown(n.dataset.wsName);
      if (n.textContent !== t) n.textContent = t;
    });
  }

  // ── seen-markers (unread dots), per browser ───────────────────────────
  const seen = () => { try { const v = JSON.parse(read(K.seen) || "{}"); return v && typeof v === "object" ? v : {}; } catch (_) { return {}; } };
  const markSeenLocal = (name, ts) => {
    const s = seen();
    if ((s[name] || 0) >= ts) return;
    s[name] = ts;
    try { localStorage.setItem(K.seen, JSON.stringify(s)); } catch (_) {}
  };
  // Only counts as read while the conversation is really in front of the person;
  // a message that lands in a hidden tab stays unread (and notifies).
  function markActiveSeen() {
    if (!state.active || !visibleNow()) return;
    const last = state.messages[state.messages.length - 1];
    if (!last || last.pending) return;
    if (M) M.markSeen(state.active, last.ts); else markSeenLocal(state.active, last.ts);
  }

  // ── network ───────────────────────────────────────────────────────────
  const creds = () => ({ ticket: read(K.id), key: read(K.key) });

  async function get(extra) {
    const qs = new URLSearchParams({ type: "chat", ...creds(), ...extra, _: Date.now() });
    const res = await fetch(`${API}?${qs}`, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  async function post(action, extra) {
    // No Content-Type header: a text/plain body is a "simple" request, so
    // there's no CORS preflight (Apps Script can't answer one).
    const res = await fetch(API, {
      method: "POST", cache: "no-store",
      body: JSON.stringify({ type: "chat", action, ...creds(), ...extra }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  // ── status / gate ─────────────────────────────────────────────────────
  function net(kind, text) {
    const s = $("net");
    s.className = "status " + kind;
    s.textContent = text;
  }

  function gate(title, text, linkText) {
    state.dead = true;
    clearTimeout(state.timer);
    $("app").hidden = true;
    $("gate").hidden = false;
    $("gateTitle").textContent = title;
    $("gateText").textContent = text;
    if (linkText) $("gateBtn").lastChild.textContent = " " + linkText;
    net("off", "Unavailable");
  }

  // ── polling ───────────────────────────────────────────────────────────
  function schedule() {
    clearTimeout(state.timer);
    if (state.dead) return;
    const base = document.hidden ? SLOW_MS : POLL_MS;
    const wait = Math.min(MAX_BACKOFF, base * Math.pow(2, Math.min(state.fails, 4)));
    state.timer = setTimeout(() => refresh(false), wait);
  }

  async function refresh(force) {
    if (state.dead) return;
    if (state.loading) { if (force) state.again = true; return; }
    state.loading = true;
    try {
      const data = await get({ with: state.active, rev: force ? "" : state.rev });
      state.fails = 0;

      if (!data || data.ok !== true) {
        // An older data.gs doesn't know ?type=chat and answers with the
        // assets list instead.
        if (Array.isArray(data) || (data && Array.isArray(data.items)) || (data && !data.code && !data.error)) {
          return gate("Chat isn't switched on yet", "The data script hasn't been updated for WannaChat. Redeploy data.gs (WS-DATA-08 or newer) and reload this page.", "Back to WannaSmile");
        }
        if (data && data.code === "ticket") {
          return gate("Your ticket can't chat", "Chat needs your own approved access ticket, with its key. If you moved browsers, re-import your data on WannaSmile first.", "Back to WannaSmile");
        }
        if (data && data.error === "Ticket required.") {
          return gate("Sign in first", "This browser's ticket isn't approved (or was removed). Open WannaSmile and finish the ticket step.", "Go to WannaSmile");
        }
        throw new Error((data && data.error) || "Unexpected reply");
      }

      state.me = data.me || state.me;
      paintMe();
      state.rev = data.rev || state.rev;
      net("live", "Live");
      // Typing flags ride on every answer, even "unchanged" ones.
      if (M) M.ingest(data, { viewing: state.active });
      if (data.unchanged) return;

      state.max = data.max || 60;
      state.friends = Array.isArray(data.friends) ? data.friends : [];
      if (state.active && !state.friends.some((f) => f.name === state.active && f.status === "friend")) {
        state.active = "";        // removed (by either of you) or never accepted
        state.messages = [];
        if (M) M.setViewing("");
      } else if (state.active && data.with === state.active) {
        // A message still being sent stays on screen until the server lists it
        // (the 60 s allowance covers a clock that is a little off).
        const listed = data.messages || [];
        const pending = state.sending ? state.messages.filter((m) => m.pending) : [];
        state.messages = listed.concat(pending.filter((p) => !listed.some((m) => m.from === p.from && m.text === p.text && m.ts >= p.ts - 60000)));
        markActiveSeen();
      }
      openWanted();
      renderFriends();
      renderConversation();
    } catch (err) {
      state.fails++;
      net("off", "Offline");
    } finally {
      state.loading = false;
      if (state.again) { state.again = false; refresh(true); }
      else schedule();
    }
  }

  // ── actions ───────────────────────────────────────────────────────────
  async function act(action, extra, okMsg) {
    try {
      const r = await post(action, extra);
      if (!r || r.ok !== true) throw new Error((r && r.error) || "That didn't work.");
      if (okMsg) toast(typeof okMsg === "function" ? okMsg(r) : okMsg);
    } catch (err) {
      toast(err.message || "That didn't work.");
    }
    refresh(true);
  }

  $("addForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("addName");
    const name = cleanName(input.value);
    if (!NAME_RE.test(name)) return toast("Usernames are 3-20 letters, numbers, _ . or -");
    if (name === state.me) return toast("That's you!");
    $("addBtn").disabled = true;
    try {
      const r = await post("request", { to: name });
      if (!r || r.ok !== true) throw new Error((r && r.error) || "Couldn't send that request.");
      input.value = "";
      toast(r.state === "friend" ? `You and @${name} are friends now` : r.state === "outgoing" ? `Request sent to @${name}` : "Done");
    } catch (err) {
      toast(err.message || "Couldn't send that request.");
    } finally {
      $("addBtn").disabled = false;
      refresh(true);
    }
  });

  function open(name) {
    state.active = name;
    state.messages = [];
    state.rev = "";
    state.lastPing = 0;
    $("chat").classList.add("open");
    if (M) M.setViewing(name);
    renderFriends();
    renderConversation();
    refresh(true);
    $("msg").focus({ preventScroll: true });
  }

  function closeConversation() {
    state.active = "";
    state.rev = "";
    if (M) M.setViewing("");
    $("chat").classList.remove("open");
    renderFriends();
    renderConversation();
  }

  $("backBtn").addEventListener("click", closeConversation);

  $("removeBtn").addEventListener("click", () => {
    const name = state.active;
    if (!name) return;
    if (!window.confirm(`Remove ${shown(name)} (@${name})? This also deletes your chat with them.`)) return;
    state.active = "";
    if (M) M.setViewing("");
    $("chat").classList.remove("open");
    act("remove", { name }, `Removed @${name}`);
  });

  // #with=<username> (notification click, or a link): open that conversation as
  // soon as the friend list is known.
  function wantFromHash() {
    const m = /(?:^#|&)with=([^&]+)/.exec(location.hash || "");
    if (!m) return;
    let n = "";
    try { n = cleanName(decodeURIComponent(m[1])); } catch (_) { return; }
    if (!NAME_RE.test(n)) return;
    state.wanted = n;
    openWanted();
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {}
  }
  function openWanted() {
    if (!state.wanted || !state.friends.length) return;
    const n = state.wanted;
    state.wanted = "";
    if (state.friends.some((f) => f.name === n && f.status === "friend")) { if (state.active !== n) open(n); }
    else toast(`@${n} isn't one of your friends yet.`);
  }

  async function send() {
    const box = $("msg");
    const text = box.value.trim();
    if (!text || !state.active || state.sending) return;
    state.sending = true;
    const to = state.active;
    box.value = "";
    state.lastPing = 0;
    updateCount();
    autosize();
    const tmp = { from: state.me, text, ts: Date.now(), pending: true };
    state.messages.push(tmp);
    renderThread(true);
    try {
      const r = await post("send", { to, text });
      if (!r || r.ok !== true) throw new Error((r && r.error) || "Couldn't send that.");
    } catch (err) {
      state.messages = state.messages.filter((m) => m !== tmp);
      if (!box.value) box.value = text;
      updateCount();
      renderThread(false);
      toast(err.message || "Couldn't send that.");
    } finally {
      state.sending = false;
      refresh(true);
    }
  }

  $("composer").addEventListener("submit", (e) => { e.preventDefault(); send(); });
  $("msg").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $("msg").addEventListener("input", () => {
    updateCount(); autosize();
    // Real typing: tell the friend while there's an unsent draft, at most every few seconds.
    if (!$("msg").value.trim()) { state.lastPing = 0; return; }
    const now = Date.now();
    if (M && state.active && now - state.lastPing >= TYPING_PING_MS) {
      state.lastPing = now;
      M.sendTyping(state.active);
    }
  });

  function updateCount() { $("left").textContent = String(MAX_TEXT - $("msg").value.length); }
  function autosize() {
    const t = $("msg");
    t.style.height = "auto";
    t.style.height = Math.min(120, t.scrollHeight) + "px";
  }

  // ── rendering ─────────────────────────────────────────────────────────
  function paintMe() {
    if (!state.me) return;
    const holder = $("meAvatar");
    if (holder.dataset.for !== state.me) {
      holder.dataset.for = state.me;
      holder.textContent = "";
      holder.append(avatar(state.me));
    }
    $("meName").textContent = shown(state.me);
    $("meUser").textContent = "@" + state.me;
  }

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const dayKey = (ts) => new Date(ts).toDateString();
  function fmtDay(ts) {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return "Today";
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
  }
  // Short stamp for the list: time today, otherwise the date.
  function fmtShort(ts) {
    const d = new Date(ts);
    return d.toDateString() === new Date().toDateString() ? fmtTime(ts) : d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  const isTyping = (name) => !!M && M.isTyping(name);
  const typingLine = (name) => (M ? M.typingText(name) : "");

  function renderFriends() {
    const list = $("list");
    const keep = list.scrollTop;
    list.textContent = "";
    const incoming = state.friends.filter((f) => f.status === "incoming");
    const friends  = state.friends.filter((f) => f.status === "friend");
    const outgoing = state.friends.filter((f) => f.status === "outgoing");
    const s = seen();

    if (incoming.length) {
      list.append(el("div", { class: "group", text: `Requests (${incoming.length})` }));
      for (const f of incoming) {
        list.append(el("div", { class: "conv-row" },
          avatar(f.name),
          el("span", { class: "tx" }, nameTag("span", f.name, "nm"), el("span", { class: "pv", text: "@" + f.name + " wants to be friends" })),
          el("button", { class: "btn sm", type: "button", title: "Accept", "aria-label": "Accept " + f.name, onclick: () => act("accept", { from: f.name }, `You and @${f.name} are friends now`) }, icon("fa-solid fa-check")),
          el("button", { class: "btn ghost sm", type: "button", title: "Decline", "aria-label": "Decline " + f.name, onclick: () => act("decline", { from: f.name }) }, icon("fa-solid fa-xmark"))
        ));
      }
    }

    list.append(el("div", { class: "group", text: "Conversations" }));
    if (!friends.length) {
      list.append(el("div", { class: "empty", text: incoming.length ? "Accept a request to start chatting." : "No friends yet. Add someone by their username above." }));
    }
    for (const f of friends) {
      const unread = !!f.last && f.last.from !== state.me && f.last.ts > (s[f.name] || 0) && !(f.name === state.active && visibleNow());
      const typing = isTyping(f.name);
      const preview = typing ? typingLine(f.name) : f.last ? (f.last.from === state.me ? "You: " : "") + f.last.text : "No messages yet";
      list.append(el("button", { class: "conv-row" + (f.name === state.active ? " on" : "") + (unread ? " unread" : ""), type: "button", onclick: () => open(f.name) },
        avatar(f.name),
        el("span", { class: "tx" }, nameTag("span", f.name, "nm"), el("span", { class: "pv" + (typing ? " typing" : ""), text: preview })),
        el("span", { class: "meta" }, f.last ? el("span", { text: fmtShort(f.last.ts) }) : null, unread ? el("span", { class: "dot", title: "New message" }) : null)
      ));
    }

    if (outgoing.length) {
      list.append(el("div", { class: "group", text: "Sent requests" }));
      for (const f of outgoing) {
        list.append(el("div", { class: "conv-row" },
          avatar(f.name),
          el("span", { class: "tx" }, nameTag("span", f.name, "nm"), el("span", { class: "pv", text: "waiting for an answer" })),
          el("button", { class: "btn ghost sm", type: "button", title: "Cancel request", "aria-label": "Cancel request to " + f.name, onclick: () => act("cancel", { to: f.name }, "Request cancelled") }, icon("fa-solid fa-xmark"))
        ));
      }
    }
    list.scrollTop = keep;
  }

  function renderConversation() {
    const on = !!state.active;
    $("idle").hidden = on;
    $("convBody").hidden = !on;
    if (!on) { $("chat").classList.remove("open"); paintTyping(); return; }
    const holder = $("peerAvatar");
    if (holder.dataset.for !== state.active) {
      holder.dataset.for = state.active;
      holder.textContent = "";
      holder.append(avatar(state.active));
    }
    $("peer").textContent = shown(state.active);
    paintTyping();
    renderThread(false);
  }

  // "<name> is typing..." under the thread and in the header; real flags only.
  function paintTyping() {
    const row = $("typingRow");
    const sub = $("peerSub");
    const on = !!state.active && isTyping(state.active);
    const line = on ? typingLine(state.active) : "";
    if (sub) {
      sub.className = on ? "typing" : "";
      sub.textContent = on ? line : state.active ? "@" + state.active : "";
    }
    if (!row) return;
    if (!on) { if (row.firstChild) row.textContent = ""; return; }
    if (row.dataset.line === line && row.firstChild) return;
    row.dataset.line = line;
    row.textContent = "";
    const dots = el("span", { class: "ws-dots", "aria-hidden": "true" }, el("i"), el("i"), el("i"));
    row.append(dots, el("span", { text: line }));
    const t = $("thread");
    if (t.scrollHeight - t.scrollTop - t.clientHeight < 120) t.scrollTop = t.scrollHeight;
  }

  function renderThread(forceBottom) {
    const box = $("thread");
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.textContent = "";
    const n = state.messages.length;
    $("cap").textContent = n ? `${Math.min(n, state.max)}/${state.max}` : "";
    if (!n) {
      box.append(el("div", { class: "empty", text: `Say hi to ${shown(state.active)}!` }));
      return;
    }
    if (n >= state.max) box.append(el("div", { class: "note", text: "Older messages are deleted automatically to keep the latest " + state.max + "." }));

    let lastDay = "", grp = null, stack = null, prev = null;
    for (const m of state.messages) {
      const dk = dayKey(m.ts);
      if (dk !== lastDay) { box.append(el("div", { class: "day", text: fmtDay(m.ts) })); lastDay = dk; grp = null; }
      const mine = m.from === state.me;
      // A new run starts for a different sender or after a pause.
      if (!grp || !prev || prev.from !== m.from || m.ts - prev.ts > GROUP_GAP_MS) {
        stack = el("div", { class: "stack" },
          el("div", { class: "by" }, nameTag("b", m.from), " · " + (m.pending ? "sending…" : fmtTime(m.ts))));
        grp = el("div", { class: "grp " + (mine ? "me" : "them") }, avatar(m.from, "sm"), stack);
        box.append(grp);
      }
      stack.append(el("div", { class: "bubble" + (m.pending ? " pending" : ""), title: m.pending ? "" : fmtTime(m.ts), text: m.text }));
      prev = m;
    }
    if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
  }

  // Everything WS_Msg can change under us: typing flags, profiles (names/pictures), unread.
  function onMsgChange(detail) {
    paintTyping();
    renderFriends();
    refreshNames();
    if (state.active) $("peer").textContent = shown(state.active);
    paintMe();
    const n = detail && detail.unread ? detail.unread.length : 0;
    $("unreadBadge").hidden = !n;
    $("unreadBadge").textContent = String(n);
    document.title = (n ? `(${n}) ` : "") + "Messages · WannaSmile4Evr";
  }

  // ── start ─────────────────────────────────────────────────────────────
  function start() {
    if (!API) return gate("Chat can't start", "The site's data address (endpoints.js) is missing.", "Back to WannaSmile");

    const approved = read(K.status) === "approved" && !!read(K.id);
    if (!approved) return gate("Sign in first", "WannaChat uses the access ticket this browser already has. Open WannaSmile4Evr, finish the ticket step, then come back here.", "Go to WannaSmile");
    if (!read(K.key)) return gate("Your ticket can't chat", "This ticket has no key, so chat can't tell it's really you. Re-import your data on WannaSmile (or request a new ticket) and try again.", "Back to WannaSmile");

    // The username is on hand straight away from the signed-in ticket; the
    // server's answer (state.me) replaces it once the first poll lands.
    state.me = read(K.user).toLowerCase();
    $("app").hidden = false;
    paintMe();
    renderFriends();
    updateCount();

    if (M) {
      // A notification (or the DM button) asking for a conversation while this page is open.
      M.setOpenHandler((name) => {
        if (state.friends.some((f) => f.name === name && f.status === "friend")) open(name);
        else { state.wanted = name; openWanted(); }
        window.focus();
      });
      M.on(onMsgChange);
    }
    wantFromHash();
    window.addEventListener("hashchange", () => { wantFromHash(); });
    refresh(true);

    document.addEventListener("visibilitychange", () => { if (!document.hidden) { refresh(false); markActiveSeen(); renderFriends(); } });
    window.addEventListener("focus", () => { refresh(false); markActiveSeen(); renderFriends(); });
    window.addEventListener("online", () => { state.fails = 0; refresh(true); });
    // Signing out (or a revoked ticket) in another tab ends this chat.
    window.addEventListener("storage", (e) => {
      if (e.key === K.status && e.newValue !== "approved") gate("Sign in first", "Your ticket isn't approved any more. Open WannaSmile to sort that out.", "Go to WannaSmile");
      else if (e.key === K.seen) renderFriends();
    });
  }

  start();
})();
