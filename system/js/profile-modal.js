// Homepage profile modal. The card is pages/profile-testing/ embedded in an
// iframe (?embed=1). "view" = card alone; "edit" = editor panel beside it.
// The two buttons underneath swap: Edit/Close <-> Disregard/Save.
(() => {
  "use strict";
  const SCRIPT_SRC = document.currentScript?.src || location.href;
  const FRAME_URL = new URL("../pages/profile-testing/index.html", SCRIPT_SRC).href;
  const $ = (id) => document.getElementById(id);
  const modal = $("profileModal");
  if (!modal) return;
  const card = $("profileModalCard");
  const frame = $("profileModalFrame");
  const primary = $("profileModalPrimary");
  const secondary = $("profileModalSecondary");
  const LABELS = {
    view: [["fa-pen", "Edit"], ["fa-xmark", "Close"]],
    edit: [["fa-rotate-left", "Disregard"], ["fa-floppy-disk", "Save"]],
  };
  let stage = "view";
  let saving = null;

  const toast = (m) => { if (typeof window.showToast === "function") window.showToast(m); };
  const post = (message) => { try { frame.contentWindow?.postMessage(message, "*"); } catch (_) {} };
  const isOpen = () => modal.classList.contains("visible");

  function paintButtons() {
    [primary, secondary].forEach((btn, i) => {
      const [icon, text] = LABELS[stage][i];
      btn.dataset.mode = stage;
      btn.querySelector("i").className = `fa-solid ${icon}`;
      btn.querySelector("span").textContent = text;
      btn.disabled = false;
    });
  }
  function setStage(next) {
    stage = next;
    modal.dataset.stage = next;
    paintButtons();
    post({ type: "ws-profile-modal-stage", stage: next });
    if (next === "edit") card.style.setProperty("--pfm-h", `${Math.max(560, parseInt(card.style.getPropertyValue("--pfm-h")) || 0)}px`);
  }
  function loadFrame() {
    card.dataset.loading = "true";
    const url = new URL(FRAME_URL);
    url.searchParams.set("embed", "1");
    url.searchParams.set("stage", "view");
    frame.src = url.href;
  }
  function open() {
    window.WS_WordFilter?.load?.();
    stage = "view";
    modal.dataset.stage = "view";
    paintButtons();
    card.style.removeProperty("--pfm-h");
    loadFrame();
    modal.classList.add("visible");
    modal.setAttribute("aria-hidden", "false");
    primary.focus({ preventScroll: true });
  }
  function close() {
    if (!isOpen()) return;
    modal.classList.remove("visible");
    modal.setAttribute("aria-hidden", "true");
    frame.src = "about:blank";
    stage = "view";
  }
  function disregard() {
    stage = "view";
    modal.dataset.stage = "view";
    paintButtons();
    loadFrame(); // reload = the editor's unsaved changes are dropped
    primary.focus({ preventScroll: true });
  }
  function save() {
    if (saving) return;
    primary.disabled = secondary.disabled = true;
    post({ type: "ws-profile-modal-action", action: "save" });
    saving = setTimeout(() => { saving = null; if (stage === "edit") paintButtons(); }, 1500);
  }

  primary.addEventListener("click", () => (stage === "view" ? setStage("edit") : disregard()));
  secondary.addEventListener("click", () => (stage === "view" ? close() : save()));
  modal.addEventListener("click", (e) => { if (e.target === modal && stage === "view") close(); });

  window.addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow) return;
    const d = e.data || {};
    if (d.type === "ws-profile-modal-ready") card.dataset.loading = "false";
    else if (d.type === "ws-profile-modal-size") {
      const max = Math.floor(window.innerHeight * 0.84) - 70;
      const h = Math.min(Math.max(d.height, d.stage === "edit" ? 520 : 300), Math.max(max, 300));
      card.style.setProperty("--pfm-h", `${h}px`);
    } else if (d.type === "ws-profile-modal-saved") {
      clearTimeout(saving); saving = null;
      setStage("view");
      toast("✅ Profile saved.");
    } else if (d.type === "ws-profile-modal-close") {
      stage === "edit" ? disregard() : close();
    }
  });

  // Esc: drop edits first, then close. Capture phase so it never reaches the
  // panic key handler; other keys stay inside the modal.
  document.addEventListener("keydown", (e) => {
    if (!isOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation();
      stage === "edit" ? disregard() : close();
    } else if (modal.contains(e.target) && e.key !== "Tab") {
      e.stopPropagation();
    }
  }, true);

  window.openProfileOverlay = open;
  window.closeProfileOverlay = close;
})();
