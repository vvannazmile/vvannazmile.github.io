(function () {
  const muted = localStorage.getItem("ws_muted") === "true";
  document.addEventListener("DOMContentLoaded", function () {
    const img = document.getElementById("muteToggleImg");
    if (img) img.src = muted ? "https://ws.ankomstudios.com/gifs/audio-btn/SHUT.gif" : "https://ws.ankomstudios.com/gifs/audio-btn/BOOM.gif";
    if (window.WS_Audio) window.WS_Audio.setMuted(muted);
  });
})();

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.querySelector(".mute-btn");
  if (!btn) return;

  btn.removeAttribute("onclick");
  btn.addEventListener("click", () => {
    const img   = btn.querySelector("img");
    const muted = localStorage.getItem("ws_muted") === "true";
    const next  = !muted;
    localStorage.setItem("ws_muted", next);
    img.src = next ? "https://ws.ankomstudios.com/gifs/audio-btn/SHUT.gif" : "https://ws.ankomstudios.com/gifs/audio-btn/BOOM.gif";
    if (window.WS_Audio) window.WS_Audio.setMuted(next);
  });
});
