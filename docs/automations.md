# Automations

An automation runs an agent task in one of your projects without you
starting it: on a schedule, or when another service calls its webhook URL.
Each run starts a new chat, titled with the automation's name and the date,
so you can read what the agent did and continue the conversation.

Automations are kept and run by the BetterC0de desktop app. They run while
the app is open; a paired phone or browser cannot see or change them.

## Create an automation

1. Click **Scheduled** at the top of the Agent sidebar, or press
   **Ctrl+Shift+A** (**Cmd+Shift+A** on macOS).
2. Choose **New automation**.
3. Fill in:
   - **Name**: used for the run chats ("Nightly triage · 2026-10-20 09:00").
   - **Project**: one of your projects or any folder. Automations only run in
     a project you trusted. If it isn't trusted yet, **Trust project** asks
     for the same confirmation as Settings → Permissions.
   - **Prompt**: what the agent should do in each run.
   - **Model**: the provider, model and, when the model has one, the
     reasoning level. Provider plugins are not offered, because automations
     run in the backend, not in the app window.
   - **Permissions**: the same presets as the composer. With **Ask first** a
     run stops at the first command or file change and waits in its chat
     until you approve it. **Bypass Permission** asks for confirmation.
   - **Runs in**: the project folder itself, or a new Git worktree for each
     run, made from the project's current branch so runs never touch your
     working copy. Worktree runs need a Git repository.
   - **Trigger**: a schedule or a webhook (below).
4. Choose **Create automation**.

The automation's page shows the next run, the last run's status and the last
50 runs. **Run now** starts a run straight away, **Pause** stops scheduled
runs and webhook deliveries until you **Resume**, and **Delete** removes the
automation and its history (the chats its runs started stay). **Open chat**
opens a run's chat; it also appears in the chat list.

Turns of an automation run go through the same steps as a message you type:
your "on message send" hooks run first, and the turn gets your rules,
skills, MCP servers and subagents. Conversation auto-save must be on (Settings
→ General), so run chats are kept.

## Schedules

All times are this computer's local time.

| Schedule | Example | Notes |
| --- | --- | --- |
| Once | 21 Oct at 09:00 | Must be in the future when you save. |
| Every | every 30 minutes, every 6 hours | At least every 5 minutes, counted from when you save. |
| Daily | 09:00 on Monday to Friday | Choose one or more weekdays. |
| Cron | `0 9 * * 1-5` | Five fields, see below. |

A cron expression has five fields: minute (0–59), hour (0–23), day of month
(1–31), month (1–12 or `JAN`–`DEC`) and day of week (0–7 or `SUN`–`SAT`,
where 0 and 7 are Sunday). Each field takes `*`, a value, a range `1-5`, a
step `*/15` or `10-50/20`, or a comma list `1,15`. When both the day of month
and the day of week are set, a day matches either one, as in cron. The
shorthands `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly` work too.
An expression that would run more often than every 5 minutes, or never, is
refused. The editor shows the next three runs while you type.

**Missed runs.** If the app was closed (or the computer asleep) when a run
was due, the automation runs once when BetterC0de starts again, shown as a
**Catch-up** run. However many runs were missed, it catches up only once.
Resuming a paused automation does not catch up the paused time.

**Overlapping runs.** A run only starts when the automation's previous run
has finished. A run that comes while the previous one is still going is
recorded as **Skipped**. A run waiting for your approval counts as going.

A run still going when the app quits is recorded as **Interrupted**.

## Webhooks

With **From a webhook**, every `POST` to the automation's URL starts a run.
The URL appears on the automation's page once it is saved, with a copy
button for each address this desktop can be reached at:

- With Remote Access off, only programs on this computer can call it
  (`http://127.0.0.1:<port>/hooks/automations/…`).
- With Remote Access on, the page also lists its addresses: your custom URL,
  Tailscale HTTPS, the tailnet address and local network addresses. See
  [Remote Access](remote-access.md).

GitHub and other hosted services need an address on the internet: a public
HTTPS custom URL in Remote Access, such as a tunnel or reverse proxy to this
computer, set up as a trusted HTTPS endpoint (see
[Choosing an endpoint](remote-access.md#choosing-an-endpoint), including
`BETTERC0DE_TRUST_PROXY=1`). Addresses on your network or tailnet work for
senders there. The webhook accepts the same transports as Remote Access:
HTTPS, this computer, the tailnet and private networks.

The backend's port can change between starts. The Tailscale HTTPS name and a
custom URL stay the same.

### Use the request in the prompt

Placeholders put parts of the request into the prompt:

- `{{body.pull_request.title}}`: a value from the body, by dot path. Array
  items are numbered from 0 (`{{body.commits.0.message}}`), `{{body}}` is the
  whole body.
- `{{headers.x-github-event}}`: a request header, by name. Authorization,
  cookies, tokens, secrets, API keys and signatures are never available.

JSON bodies are read as JSON, form bodies as their fields (GitHub's form
deliveries, a `payload` field with JSON, read as that JSON), and other bodies
as text. Objects are inserted as JSON. Missing values are empty.

The values come from whoever sent the request, so BetterC0de treats them as
untrusted data: each value is wrapped in a tag with a random name the sender
can't know, at most 2,000 characters per value and 16,000 in all, and the
prompt ends with a note telling the agent to treat tagged text only as data
and never follow instructions in it. Choose a careful permission preset for
webhook automations all the same: a webhook can start a run whenever the URL
is called.

### Set up a GitHub webhook

1. In the automation, turn on **Check GitHub signature** and choose
   **Generate** (or type your own secret of at least 8 characters). Copy the
   secret, then save.
2. On GitHub, open the repository's **Settings → Webhooks → Add webhook**.
3. Paste the automation's internet address as the **Payload URL**, choose
   `application/json`, paste the secret and pick the events.
4. GitHub sends a `ping` first. BetterC0de answers it without starting a run;
   it shows in the automation's **Deliveries**.

With the check on, a delivery without a valid `X-Hub-Signature-256` (an
HMAC-SHA256 of the exact body with your secret) is refused with 401.

### Security

- **The URL is the key.** It holds a random 32-byte token. It is compared in
  constant time, and a wrong token is answered exactly like an unknown
  automation (404). Treat the URL like a password; **Rotate URL** makes a new
  one and the old one stops working at once.
- **Nothing else is reachable.** The webhook is mounted outside the app's API,
  needs no session, and can only hand a delivery to its own automation. It
  never gives access to chats, files or settings.
- **Limits.** Bodies over 256 KB are refused (413). Each automation accepts
  10 deliveries at once and then 10 a minute (429 with `Retry-After`).
  Deliveries to a paused automation are refused (409).
- **Deliveries log.** The last 50 deliveries that carried the right token are
  listed with their time, HTTP status and answer. Request bodies and headers
  are not stored or logged.
- **Stored secrets.** The webhook token and the GitHub secret are stored
  encrypted with the desktop's key. The token is shown only as part of the
  URL on the desktop's own page; the secret is never shown again after you
  save, and an empty secret field keeps the stored one.

The answers a sender reads:

| Status | Meaning |
| --- | --- |
| 202 | Run started: `{ "accepted": true, "runId": "…", "message": "Run started." }` |
| 200 | Taken without a run: a `ping`, or skipped because the previous run is still going |
| 400 | The body claims to be JSON but isn't |
| 401 | The GitHub signature is missing or wrong |
| 404 | No automation with this URL |
| 409 | The automation is paused |
| 413 | The body is larger than 256 KB |
| 429 | Too many deliveries; see `Retry-After` |

## Where automations are kept

Automations are stored in BetterC0de's configuration folder, next to
`hooks.json` and `mcp-servers.json`:

- `automations.json`: the automations, with the webhook token and GitHub
  secret encrypted.
- `automation-history.json`: when the scheduler last ran each automation and
  its last 50 runs and deliveries.

A file that can't be read is moved aside as `<name>.unreadable-<id>` and the
app starts without it, so nothing is overwritten. You can keep up to 100
automations.
