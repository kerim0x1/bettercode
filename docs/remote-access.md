# Remote Access

Remote Access lets a phone, tablet, or another browser operate the BetterC0de
instance running on your desktop. The desktop remains the host: it owns the
database, chats, projects, files, terminals, provider processes, and API/CLI
credentials. The remote device is another authenticated view of that same live
environment.

## Quick start

1. Keep the BetterC0de desktop app running.
2. Open **Settings → Remote Access** and turn on **Remote Access**, or run
   `/remote` in a chat.
3. Allow the operating-system firewall prompt for private networks if one
   appears.
4. Create a one-time link. Scan its QR code or share/copy the recommended LAN
   URL to the trusted device.
5. Before its 10-minute expiry, either open the link in a browser or scan it
   from **BetterC0de Remote**. The paired browser or phone becomes a separately
   revocable session.

`/remote` enables the listener when necessary and creates a fresh pairing link.
The related commands are:

```text
/remote                 Enable when needed and create a one-time link
/remote status          Show listener, endpoint, and paired-session status
/remote link            Create another one-time link
/remote off             Return the backend to loopback-only listening
/remote tailscale on    Optional: also publish the host over Tailscale Serve HTTPS
/remote tailscale off   Remove the Tailscale Serve mapping
/remote settings        Open the Remote Access settings tab
```

Only the desktop app can enable/disable hosting, create pairing links, or
manage other devices. A remote browser can use the IDE and sign out its own
session, but it cannot turn itself into an access administrator.

## Native mobile app

`apps/mobile` is a real Expo/React Native application rather than a WebView. It
provides touch-native screens for:

- searching, opening, creating, and continuing desktop-hosted chats;
- live assistant and reasoning streams with reconnect replay;
- model selection, the desktop's permission presets and chat modes per chat,
  stop controls, tool/plan approvals, and provider questions;
- a queue for messages written while the agent works, and **Retry** for a
  message that did not arrive, which the desktop recognises, so a retried
  message never runs twice;
- which chats wait for an answer (in the chat list, on the **Chats** tab and
  in every other chat), kept current as approvals are answered on the
  desktop, and the agent's tool steps while it works;
- renaming a chat, which the desktop and every other paired device take over
  at once (`POST /api/v1/threads/:id/title`, announced as the
  `threads.rename` feature and sent to clients as a `thread.metadata`
  frame), and deleting one, which also removes its worktree on the desktop,
  with any changes there that are not committed;
- starting a chat in its own git worktree, on a new branch from a branch the
  phone lists, and restoring a checkpoint: the chat and the whole project
  folder return to the end of an earlier turn, after the desktop's warning
  of what that discards;
- photos in a message, from the photo library or the camera. Like the
  desktop's attachments they travel inside the message, to the paired desktop
  only. The phone encodes each photo again as a JPEG of at most 1568 pixels
  on its long edge, which leaves out the camera's metadata, location
  included, and keeps a message within the desktop's request limit (2 MB).
  Whether the agent sees them depends on the provider, as on the desktop:
  Claude Code gets only their names, for now;
- source control for a chat's folder or a project, like the desktop's git
  panel: status, staging and unstaging files or single changes, discarding,
  commits with a message the desktop generates, fetch, pull, push and
  publishing a branch, switching and creating branches, and the latest
  commits. A read-only session gets none: the desktop refuses every git
  request from it;
- project browsing plus chat-scoped files, text previews, diffs (in full,
  file by file), and checkpoints; new files and folders, renaming and
  deleting (a new file is never written over an existing one), and a search
  of the files' text with the desktop's options;
- host health, session identity, expiry, and self-revocation.

The desktop prepares a message from the phone as it prepares its own (the
phone asks for it with `prepareTurn`, and desktops that do announce
`chat.preparedTurns`):

- Your **on message send** hooks run first, in order. One that fails stops
  the message, and the phone shows the hook and what it printed
  (`message_hook_failed`). A `/goal` command runs them once, not for each
  of the goal's turns. The hook's last run, as the desktop's hook settings
  show it, is recorded only for messages sent on the desktop.
- The turn gets the system instruction the desktop builds: the mode and
  permission preset, the project, your skills, MCP servers and subagents
  and the project's own, the project's permission rules, and your rules and
  the project's rule files.

Build and start a development build from the repository root (see
[apps/mobile/README.md](../apps/mobile/README.md)).
Use **Scan QR** inside the app; the existing desktop QR works for both the
browser and native client. **Enter manually** also accepts the LAN host and
short code separately.

The native client exchanges the one-time code at the dedicated mobile pairing
endpoint. The returned opaque bearer is stored with iOS Keychain/Android
Keystore via Expo SecureStore and sent only to the paired host. It authenticates
both HTTP requests and the in-band WebSocket handshake. Browser pairing remains
cookie-only and never exposes its session token to page JavaScript.

### Plain HTTP on the phone

Direct connections on a private network or tailnet use plain HTTP (see
[Choosing an endpoint](#choosing-an-endpoint)), so the app has to allow it:

| Platform | What the app allows | Why |
| --- | --- | --- |
| iOS | Plain HTTP to IP addresses, `.local` and single-label host names (`NSAllowsLocalNetworking`), and to Tailscale MagicDNS names under `ts.net`. HTTPS everywhere. | iOS App Transport Security does not apply to IP addresses, and the local-networking key covers local names. Other plain-HTTP host names, such as `desktop.fritz.box`, are refused by iOS; use the desktop's IP address or HTTPS instead. |
| Android | Plain HTTP to any address (`usesCleartextTraffic`). | Android's network security configuration can allow host names but not address ranges, and the desktop's LAN or Tailscale IP is not known when the app is built. |

The app itself only ever connects to the desktop it was paired with, using the
addresses that desktop advertised.

## Choosing an endpoint

BetterC0de advertises every usable IPv4 interface plus a loopback URL. It picks
the first non-loopback address as the recommended link **only when that URL is
actually usable for pairing**.

Enabling Remote Access binds `0.0.0.0` (or `BETTERC0DE_REMOTE_HOST` if set)
and advertises every private-network IPv4 interface. **Plain
`http://192.168.x.y:<port>` pairing from a private network is ordinary
pairing**: the phone on your Wi-Fi scans the QR and gets a full session,
without an additional network service. What is refused without TLS is
a *public* peer: a port forwarded from a router returns 426 unless
`BETTERC0DE_ALLOW_INSECURE_REMOTE_ACCESS` is set, and then only read-only.

- **Private network (recommended at home):** RFC 1918, link-local and IPv6
  ULA peers — your Wi-Fi, office LAN, or VPN. Full 30-day session over plain
  HTTP. The pairing layer (one-time code, revocable session) is the
  authentication; the private network is the transport boundary.
- **This computer:** The `127.0.0.1` link works for testing on the host.
- **Trusted HTTPS endpoint:** Configure a reverse proxy or tunnel that forwards
  HTTPS/WSS to the BetterC0de port, then enter its full `https://` URL in Remote
  Access settings. HTTPS pairing issues a full-access session for 30 days.
  Set `BETTERC0DE_TRUST_PROXY=1` so the backend reads the client from the
  proxy's `X-Forwarded-For` and `X-Forwarded-Proto` headers. Only the
  **rightmost** `X-Forwarded-For` entry counts (the one your proxy appended);
  anything a client prepends, and `X-Real-IP`, is ignored, so a public
  peer cannot claim a LAN address to skip the TLS requirement.
- **Other VPNs:** Prefer a stable `https://` hostname on the mesh. A bare
  HTTP mesh IP that is not a Tailscale address is treated like LAN HTTP.
- **Tailscale (away from home):** With Tailscale running on the desktop and
  the phone, the tailnet address is advertised as `http://100.x.y.z:<port>`
  and the phone pairs with a full 30-day session from anywhere — no
  certificate, no flag. See [Tailscale](#tailscale).
- **Opt-in public plaintext:** Set `BETTERC0DE_ALLOW_INSECURE_REMOTE_ACCESS=1`
  before starting the desktop app if you intentionally want plaintext pairing
  from a public address. Those sessions are **read-only and expire after one
  hour**. They cannot send chats, approve tools, write files, or open a
  terminal.

BetterC0de serves its own web bundle at every advertised direct URL. HTTP API,
WebSocket, cookies, and the app therefore remain same-origin. There is no
BetterC0de relay and no chat data is copied to a hosted web service.

Do not forward this port from a router without TLS. The mobile app is a paired
client of the desktop host, not a second full host.

## Tailscale

On the same Wi-Fi you do not need Tailscale at all — see *Private network*
above. Tailscale is for using the phone away from home: it gives every device
a private address and encrypts everything between them with WireGuard, after
authenticating each device against your tailnet. BetterC0de treats that tunnel
as transport security: the direct tailnet endpoint needs no separate TLS
certificate, and the phone app talks HTTP *inside* the encrypted tunnel.

1. Install Tailscale on the desktop and sign in. Install it on the phone and
   sign in to the same tailnet.
2. Turn on Remote Access. The **Tailnet** row in Settings → Remote Access
   shows *Connected · 100.x.y.z* and the reachability list gains a
   **Tailscale** endpoint, `http://100.x.y.z:<port>`, which becomes the
   recommended pairing link.
3. Create a one-time link and scan the QR in **BetterC0de Remote** from
   anywhere the phone has connectivity — the tailnet does not care whether it
   is the same Wi-Fi. The session is full and lasts 30 days.

**How the backend recognizes the tunnel.** A request counts as *tailnet
transport* when its TCP peer is a Tailscale address (100.64/10 or
fd7a:115c:a1e0::/48) **and** the local socket address it arrived on is one of
this machine's own addresses from `tailscale status`. Packets on the
Tailscale interface can only come from authenticated peers, and checking the
local side against the real addresses rules out an ISP that happens to use
the same CGNAT range on a physical interface. Such a request is neither
"secure" (no TLS, so browser cookies are not marked `Secure`) nor "insecure"
(no read-only downgrade): it is private. The same rule applies to WebSocket
upgrades. Behind a trusted proxy the direct peer is the proxy, so the rule
never applies to forwarded requests.

**Optional: HTTPS through Tailscale Serve.** A browser on the tailnet may
want a secure context (clipboard, camera, notifications). Turn on **Serve
over Tailscale HTTPS** (or `/remote tailscale on`) and BetterC0de runs
`tailscale serve --bg --https=443 http://127.0.0.1:<backend port>`; Tailscale
issues a certificate for `https://<machine>.<tailnet>.ts.net` and that
endpoint is advertised as well. This needs **MagicDNS** and **HTTPS
Certificates** enabled in the Tailscale admin console (DNS page); the
settings row says so when they are missing. Turning the switch off runs
`tailscale serve --https=443 off`, which removes whatever Tailscale served on
that port. Disabling Remote Access removes the mapping too and remembers the
switch; the mapping is re-applied to the bound port at every start because
the port can change between launches.

Serve terminates TLS on the desktop and proxies to `127.0.0.1`, so the backend
sees a loopback TCP peer with `X-Forwarded-Proto: https` and
`X-Forwarded-For: 100.x.y.z`. While the serve setting is on those headers are
trusted **only from loopback peers** (`ServerConfig.trustLoopbackProxyHeaders`),
which makes such a request a remote HTTPS client rather than "the desktop":
full session on pairing, never the owner's rights, and a remote TCP peer
sending the same headers is still refused with 426. The general
`BETTERC0DE_TRUST_PROXY` flag for an external reverse proxy is unchanged.

## Pairing and sessions

The flow follows BetterC0de's owner/client model:

1. The desktop owner creates a random one-time pairing code.
2. The server stores only its SHA-256 digest and gives the owner a link whose
   URL fragment contains the secret.
3. The new browser or native app exchanges the code once. Used or expired
   codes cannot be replayed.
4. The server creates a session. **HTTPS / loopback / private network /
   tailnet pairing:** 30 days, `accessLevel: "full"`. **Opt-in public
   plaintext:** 1 hour,
   `accessLevel: "read_only"`. Browsers receive the secret as an `HttpOnly`,
   `SameSite=Strict` cookie; the native app receives it only in the no-store
   pairing response and moves it directly into secure device storage. SQLite
   stores only a digest in both cases.
5. Browser requests use the cookie. Native HTTP requests use `Authorization:
Bearer`, while the native WebSocket uses the authenticated in-band handshake.
   Revoking one device invalidates both transports without rotating the
   Electron process bearer or disconnecting other devices.
6. Direct terminal input receives a short-lived, one-shot capability bound to
   that exact command or PTY operation. Only the desktop IPC bridge or a valid
   paired session can mint one.

The original Electron bearer remains private to the main process. It is
injected only onto trusted loopback requests and is not reused for remote web
sessions.

## Managing devices

The **Paired devices** list shows each browser label and last activity. Use the
trash action to revoke one device, or **Revoke all** to invalidate all remote
sessions. Disabling Remote Access revokes every paired device at once and
closes network listening after the backend restart; re-enabling it later
means pairing each device again. A terminal for paired devices is a separate
switch, **Allow terminal from remote devices**, which is off by default. A
paired device can change neither that switch nor any setting that makes the
desktop run something (MCP servers, hooks, skills, pipelines, rules,
guardrails, provider credentials, workspace auto-trust, backend logging):
those return 403 to a remote session.

A **full** session (HTTPS, loopback, private network, tailnet) can operate
the chats and workspaces the host exposes, including reading and changing
files, and a terminal when the switch above is on. There is no separate switch
for file access. Like the desktop, it can choose any permission preset for a
chat, including **Bypass Permission**, under which the agent runs commands and
edits files without asking; the phone app shows the desktop's warning before
it switches. The preset travels with each message the device sends. It can
also answer a tool approval with **Always allow** for this session, this
project or all projects, as the desktop can; the app shows the exact rule
before it is stored. Such a rule is stored on the desktop: it stays after the
device is signed out or revoked, until it is removed on the desktop. An
**opt-in public plaintext** session cannot do any of this; it is
monitoring-only. Pair only devices you control, revoke lost devices promptly,
and do not post pairing links in shared channels.

## Phone app and desktop versions

The phone app and the desktop update separately, so a paired phone can run an
older or newer release than the desktop. They check that they understand each
other on every connection:

- `/api/v1/remote/bootstrap`, the pairing response and the WebSocket `auth_ok`
  frame carry a `protocol` block: the desktop's protocol version
  (`apiVersion`), the oldest phone app it serves (`minClientVersion`) and, for
  a paired device, what this desktop offers it (`capabilities`: access level,
  whether a terminal is allowed, the largest request, and additive
  `features`). The desktop sends the block again (`protocol_update`) when the
  terminal switch changes.
- The phone app names itself on every request with
  `X-BetterC0de-Client: betterc0de-remote/<version> (<platform>)`, and in the
  WebSocket `auth` frame. **Paired devices** shows each phone's app and
  version.
- An app below the minimum gets `426` with `code: "client_update_required"`
  (HTTP) or close code `4426` (WebSocket). Its pairing stays valid; the app
  asks for an update instead of pairing again. Signing out still works.

Every refusal a paired device can receive carries a `code`:

| Status | `code` | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | The session is unknown, expired or revoked; pair again. |
| 401 | `pairing_code_invalid` | The one-time code was already used or has expired. |
| 403 | `remote_access_disabled` | Remote access is turned off on the desktop. |
| 403 | `remote_read_only` | A read-only session tried to change something. |
| 403 | `desktop_only` | Only the desktop itself may use this endpoint. |
| 403 | `remote_terminal_disabled` | The terminal is not allowed for paired devices. |
| 413 | `request_too_large` | The request is larger than `capabilities.maxRequestBytes`. |
| 426 | `secure_transport_required` | Plain HTTP from a public address. |
| 426 | `client_update_required` | The phone app is older than `minClientVersion`. |
| 429 | `rate_limited` | Too many requests; wait for `Retry-After`. |

Source control answers with the desktop's own words and these codes:
`git_nothing_to_commit` (400, nothing staged and nothing to stage),
`git_hunk_conflict` (409, the change is no longer in the diff),
`git_remote_error` (400 to 409, push, pull or fetch refused: no remote, no
upstream, authentication, the remote is ahead, local changes in the way) and
`commit_generation_unavailable` (422, no Codex or Claude CLI could write the
message).

Developers: `packages/schema/src/remote-protocol.ts` defines the block. Raise
`REMOTE_API_VERSION` only for a change an installed app cannot handle (a
removed or renamed field, a new value in a response enum, different auth or
semantics) and announce additive changes in `capabilities.features`. A
snapshot test (`apps/backend/src/http/remote-contract-snapshot.test.ts`) fails
on every change to a response contract the phone app compiles in.

## Troubleshooting

- **The phone cannot open the LAN link:** Confirm both devices are on the same
  network, the desktop is awake, BetterC0de is still running, and the firewall
  permits the app on private networks. Guest Wi-Fi commonly isolates clients.
- **The link says the code is invalid or expired:** Create a new link. Pairing
  codes are deliberately one-use and expire after 10 minutes.
- **The custom URL opens but cannot connect:** Confirm the proxy forwards both
  ordinary HTTP and WebSocket upgrades and preserves the request `Host`.
- **HTTPS page to HTTP backend fails:** Browsers block mixed content. Open the
  direct HTTP page served by the backend on a private network, or expose the
  backend itself through HTTPS/WSS.
- **Remote Access is on but no network address appears:** Retry after the
  backend restart and verify the machine has an active IPv4 network interface.
