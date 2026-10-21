# Security

BetterC0de is beta software. Security fixes target the latest development branch and latest published beta; there is no long-term support commitment for older versions.

## Report a vulnerability privately

Use GitHub's **Report a vulnerability** option in this repository's Security tab when private vulnerability reporting is enabled. If the option is unavailable, ask the maintainer for a private reporting channel through the [BetterC0de community](https://discord.gg/bettercode), without posting vulnerability details publicly.

Include the affected version, operating system, impact, and reproducible steps. Use a minimal reproduction with dummy credentials and synthetic project data. Do not submit working API keys, private repositories, or personal conversation logs.

Ordinary bugs can go through the issue tracker or the app's report panel. That panel is not a dedicated confidential vulnerability-reporting channel.

## Areas that deserve particular care

- Provider authentication and credential storage.
- File access, project boundaries, and remote pairing.
- Electron main-process IPC, browser previews, and untrusted content.
- Agent permissions, tool execution, and plugin installation.
- Update metadata, release artifacts, and signing credentials.

## Protections in the desktop app

These are the defaults a report should be measured against. A way around one of them is a vulnerability.

- **Workspace trust is explicit.** Opening or cloning a folder does not trust it. Agent Mode turns, the repository's own MCP servers (local commands and remote URLs), formatter commands, and Claude Code's project and local settings, including their hooks, run only after **Settings → Permissions → Trust project**. Automatic trust (`auto_trust_workspaces`) is off for new installs; an existing install keeps its saved choice. Marking a workspace untrusted always wins. Folderless chats run in an app-owned scratch workspace that needs no trust decision. See [workspace trust](docs/development/workspace-reference.md#workspace-trust).
- **Repository configuration stays in its repository.** **Sync from CLI** and the onboarding import copy only user-level CLI configuration into BetterC0de's global MCP, skill and agent lists. Project-scoped servers, skills and agents stay with their workspace, and a project server cannot replace one of your own. Servers imported from projects by earlier versions carry no origin and still run in every workspace; review the MCP list once after upgrading.
- **Opening a repository does not run its programs.** On Windows, git, shells and helper tools are resolved to absolute paths outside the workspace, and the backend sets `NoDefaultCurrentDirectoryInExePath`, so a `git.exe` or `codex.bat` committed to a repository is not executed.
- **Secrets at rest.** Provider API keys in `settings.json` and MCP environment values and headers in `mcp-servers.json` are encrypted with a key that the operating system's credential storage protects. When that storage is unavailable, the files stay in plaintext. The renderer sees stored MCP values only as `••••••••`, and the system prompt names MCP servers without their commands, URLs or credentials. Electron hands the key to the backend over the private fork IPC channel, never through environment variables.
- **Saved commands need a native confirmation.** Adding or changing a hook command, or an MCP server that runs a command, shows a main-process dialog with the exact command; only **Allow** stores it. Installing a Claude Code or Codex plugin shows the exact `claude plugin install` or `codex plugin add` command the same way, because a plugin can bring hooks, MCP servers and commands that the CLI runs in later sessions; only **Install** runs it. Approved hooks then run automatically.
- **Message hooks fail closed.** "On message send" hooks run in the backend before every message from every client, the desktop, the paired browser and the phone alike. A message is refused while `hooks.json` cannot be read, or while an enabled hook's command has not been approved on this computer, instead of the hook being skipped. Other hook events saved by earlier versions without an approval run only right after a click or key press until they are saved again.
- **Permission levels.** `full` and `full-access` mean allow-edits for every provider; only an explicit **Bypass Permission** grants bypass, and a session without a stored mode does not fall back to it. Image generation asks for approval below Bypass, and the commands its Codex run executes get no network access and no write access to shared temporary folders.
- **Remote access is limited by transport.** A full session needs HTTPS, Tailscale or this computer. Pairing over plain HTTP on a local network, or over public plaintext when `BETTERC0DE_ALLOW_INSECURE_REMOTE_ACCESS` is set, gives a read-only session for one hour, for HTTP and WebSocket alike. A paired device runs Bypass turns or a terminal only while **Allow terminal from remote devices** is on, and never saves permanent permission rules. Sessions end after 30 days or 7 days without use, pairing links last at most one hour, and turning remote access off revokes every session and unused link. See [Remote Access](docs/remote-access.md).
- **Privacy by default.** Automatic crash reports and the usage ping are off until turned on in **Settings → Privacy & Diagnostics**. Reports and the local application log are redacted (credential formats, credential-named values, URL user info, email addresses and the home folder path). The ping is sent once per start, and without consent the installation ID is deleted. See [Diagnostics and data](PRODUCT_GUIDE.md#diagnostics-and-data).
- **Electron hardening.** Packaged builds set Electron fuses: `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS` and `--inspect` are ignored, cookies are encrypted, and only `app.asar` loads, with integrity validation on macOS and Windows. `RunAsNode` stays enabled because the backend runs as the app binary with `ELECTRON_RUN_AS_NODE`. The macOS build no longer requests the DYLD environment entitlement. DevTools stay closed in packaged builds unless the app is started with `BETTERC0DE_ENABLE_DEVTOOLS=1`. The renderer's Content Security Policy allows neither `unsafe-eval` nor inline scripts; the page the backend serves to a paired browser lets through only its own runtime-config script, by a nonce that changes with every response. Preview pages cannot open popups or navigate to `file:` or browser-internal pages, keys typed into a page are not forwarded to the app (only modifier keys for canvas gestures), and a page cannot add selected elements to a chat without a recent click or key press.
- **Visual replies are sandboxed.** HTML an agent writes in a ```` ```html-render ```` block (or an `html` block shown with **Preview**) never runs in the app's document. The chat loads a static host page (`apps/ui/public/visual-reply-frame.html`) in an `<iframe sandbox="allow-scripts">` with `referrerpolicy="no-referrer"`: an opaque origin with no access to the app, its storage, cookies or IPC bridge, and no forms, popups, downloads, modals or top-level navigation. The agent's page arrives by `postMessage`, which the chat accepts only from that frame's own window with origin `null`, and the host page shows it in a nested `<iframe sandbox="allow-scripts" srcdoc>` that inherits the host page's policy: `default-src 'none'`, scripts inline or from cdn.jsdelivr.net, cdnjs.cloudflare.com and unpkg.com, styles inline or from fonts.googleapis.com and cdn.jsdelivr.net, fonts from fonts.gstatic.com, images over https or as data, and no fetch, XHR, WebSocket, frames, form submission or navigation to another address (the host page's `frame-src 'none'` governs its nested frame, also in a paired browser). Only the page's height and Escape are passed on to the chat. The host page does nothing unless it runs inside such a sandbox, and in the desktop app the main process also refuses any navigation of the host frame away from its page. Images over https can still reveal that a page was opened to the server that hosts them. **Settings → Chat → Visual Replies** turns pages off; they then show as code.

## Local and CI configuration

Keep secrets in local environment variables or your CI secret store. `.env.example` contains documentation only. The repository workflows set `BETTERC0DE_DISABLE_PING` and `BETTERC0DE_DISABLE_CRASH_REPORTS`, which keep the usage ping and automatic crash reports off whatever the settings say; see [diagnostic controls](docs/development/README.md#diagnostics-during-development).

## If a signing credential leaks

The phone app's signing credentials are secrets of the `release` environment and offline backups; see [code signing](docs/development/code-signing.md#the-phone-app-is-signed).

- **`EXPO_TOKEN`**: revoke it at expo.dev → Access tokens, create a new one, and replace the secret.
- **App Store Connect API key**: revoke it in App Store Connect → Users and Access → Integrations, create a new one, and store it with `eas credentials`.
- **Android release keystore**: anyone holding it can sign APKs that install as updates of BetterC0de Remote. Publish an advisory, create a new key, pin its certificate, and release a build signed with it. Users must uninstall and reinstall to move to the new key (or receive a v3 key rotation; see the code-signing page), and pair again.

Known dependency advisories and the decisions taken during source preparation are documented in the [dependency security review](docs/development/dependency-security.md). Re-run the audit before a release; the recorded results are a dated snapshot.
