# Redeploying data.gs

The site talks to one Apps Script web app (`WS_ENDPOINTS.data` in `system/js/endpoints.js`):

`https://script.google.com/macros/s/AKfycbwJMjRfHTMG1xn7EoHViyBzbyJ01i_eaDdAzcSnRa38rhxsFR2GGHeKHEK_cXwHS1qe/exec`

`data.gs` build **WS-DATA-08** contains WannaChat (now with real typing flags and chat profiles), ProfileNet (see [`profile-api.md`](profile-api.md)) and library reports. Until it is redeployed, the live URL still serves the old build and the chat page will show an error.

1. Open the Apps Script project behind that URL and replace the whole of `Code.gs` with `data.gs`. Save.
2. **Deploy → Manage deployments → ✏️ edit the existing deployment → Version: New version → Deploy.**
   Editing the existing deployment (not "New deployment") keeps the same `/exec` URL.
3. In the editor run **`installChatCleanupTrigger`** once and approve the permissions. It adds a daily trigger for `chatCleanup`. Safe to run again.
4. Check `<exec url>?type=build` answers `WS-DATA-08`.
5. **Typing quotes:** put the lines in **column C** of `QuoteSystemWS` (header in C1, one line per cell below). `(someone)` becomes the typer's display name and `(is-typing)` becomes "is typing", e.g. `(someone) (is-typing)...` or `ankom studios (is-typing)...` (a line that starts with a name is used only when that person is typing). Columns A and B are untouched; an empty column C just gives "<name> is typing...". Check `<exec url>?type=typingquotes&ticket=…&key=…`.
6. **Reports:** the tab `ReportsWS` is created on the first report (`Timestamp | TicketID | Username | Reason | Title | Author | Link | Status`). Title and Author come from `AssetBuilderWS` by link, not from the browser. Set `Status` by hand (it starts as `open`).
7. The sheets `ChatFriendsWS and `ChatMessagesWS` are created on first use. For profiles, paste `ProfileNetWS.tsv` into row 1 of a tab named `ProfileNetWS` (or skip it and the script creates the tab).

`chatCleanup()` is the merge/clean-up pass: it re-trims every chat to the newest 60 messages, drops chats whose friendship is gone, drops friend requests unanswered for 30 days, and drops anything belonging to a ticket that is no longer approved. You can run it by hand any time.

Optional, only for the websocket worker: set a Script Property `SECRET_TOKEN` if you want to use the `userexists` POST (the worker in this folder does **not** need it).
