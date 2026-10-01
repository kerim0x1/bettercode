# Providers and API keys

Open **Settings → Providers** to configure direct API access, CLI accounts, or local models. **Claude API**, **OpenAI API**, and **Grok (xAI)** each support up to 20 saved keys.

## Add and manage keys

1. Enable the API provider.
2. Enter a descriptive key name and the API key, then select **Add key**.
3. Select **Check key** to verify authentication. The check lists model metadata; it does not generate a paid response or verify remaining credits.
4. Add backup keys and use the up/down buttons to set their priority. New requests try enabled, available keys in that order.

Each key can be renamed, replaced, disabled, or removed. Saved values are write-only: the settings UI receives status metadata, never stored key values. Keys use the existing encrypted settings storage. An explicitly configured plaintext fallback is labeled as plaintext in the UI.

An existing single saved key becomes the first entry when you add a backup or edit it in this screen. Environment and CLI-configuration credentials remain usable until you create a saved list. They are read-only here and are not copied into settings. A saved list takes precedence; disabling or removing every entry does not reactivate environment credentials. Choose **Use environment or CLI configuration** and confirm to remove the saved list and return to external credentials.

## Recovery behavior

If a model request fails before receiving a response, BetterC0de can try the next eligible key **for the same provider**. It does not switch models or providers.

| Status | Behavior |
| --- | --- |
| Authentication failure | Skip the key until you replace it, check it successfully, or choose **Retry key**. |
| Credits or spend/usage limit exhausted | Skip the key until billing is restored and you choose **Retry key**. A successful model-list check alone does not clear a billing failure. |
| Rate limit | Wait until the provider's `Retry-After` deadline (30 seconds if none is supplied) before using that key again. An eligible backup can serve the current request. |
| Temporary service, transport, or timeout failure | Try an eligible backup; the failed key waits at least the supplied retry delay, or five seconds by default. |
| Invalid request, unavailable model, permission, policy, region, or IP restriction | Stop and show the error. Correct the request or account configuration. |

Each request tries a key at most once. SDK retries are disabled for these managed providers, and opening an API request has a 60-second timeout. The existing overall turn deadline still applies. Limits may be shared by several keys on the same account; backup keys do not increase an account's limits.

Recovery continues the existing agent tool loop. It does not reopen the MCP session or repeat executed tools. After any response event arrives, a failure ends that request and preserves the partial output. An interruption stops recovery. Active turns keep their credential snapshot; settings changes apply to subsequent turns.

Short API helper requests, such as chat titles and question extraction, also use the saved backup keys and respect the API provider's enabled state. Their existing provider-selection order and overall timeout stay the same.

Key health is kept in memory and refreshed while the settings screen is open. Restarting the backend clears that health history. Removed or replaced credentials cannot update their replacement's status when an older request finishes.

## Models and CLI accounts

Account model lists come from the provider API and stay cached separately for each credential. **Refresh models** reloads them; **Visible Models** controls which IDs appear in the picker, and **Custom Models** accepts an additional model ID. Model access still depends on the account and selected key.

Direct API billing is separate from a ChatGPT, Claude, or Grok subscription. Subscription logins remain under the existing CLI account entries. API-key management does not change the CLI harness, approvals, permissions, or tools.

## 9Router

[9Router](https://github.com/decolua/9router) is a local router that puts Claude Code, Codex, GitHub Copilot, Kiro, Gemini and API-key accounts behind one OpenAI-compatible endpoint. BetterC0de can use several 9Router connections at once, for example the router on your laptop and one on a server.

### Connect a router

1. Start 9Router, for example with `npx 9router`. It listens on `http://localhost:20128` and opens its dashboard.
2. Open **Settings → Providers → 9Router**. When a router is running on this computer, BetterC0de shows it; choose **Use this router**.
3. Enter a name and the router URL. `localhost:20128`, the dashboard URL or a tunnel URL all work; BetterC0de uses the `/v1` endpoint.
4. Paste an API key from the 9Router dashboard (**Keys**). 9Router requires a key for chat requests unless **Require API key** is turned off there. Routers on another machine always need one.
5. Select **Add and check**. BetterC0de checks the router, reads its version and loads its models.

Each connection shows its status (**Online** with version, response time and model count, **Needs API key**, **Offline**, or **Error**), whether a key is saved, and a link to its dashboard. **Check and reload models** repeats the check. Keys are write-only and encrypted with the other provider keys. A saved key is only sent to its own router: changing a connection's URL requires entering the key again or removing it.

### Models

The model list comes from the router's `/v1/models` and is cached for five minutes per connection. It contains the accounts that are active in 9Router and your combos. In the model picker each connection is its own group; models are grouped by account (**Combos**, **Claude Code**, **Codex**, …) and the list can be searched.

- **Models** on a connection card switches models on or off for the picker.
- **Custom model** adds any ID 9Router can route, such as a model it does not list or `cx/gpt-5.5(xhigh)`, whose suffix pins the thinking level. You can also type an ID in the picker's search field and choose **Use … as model**.

Model IDs are sent to 9Router unchanged, including the account prefix. 9Router decides which account serves a request; combos fall back across accounts. A paired phone (BetterC0de Remote) lists the same models of reachable connections and runs them through the desktop; router addresses and keys never leave the desktop, and connections can only be managed there.

### Reasoning

The reasoning control offers the levels 9Router reports for each model. Claude and Gemini models start on **Auto (adaptive)**, where the model decides how long to think; you can also choose **Off** or a fixed level up to **Max** where the model supports it. 9Router translates the level for the upstream account and lowers one the model does not support. Reasoning text is shown as the response streams. Models without reasoning have no reasoning control; custom model IDs get the general ladder.

### Token saver and usage

9Router compresses tool output by default to save tokens. Turn off **Token saver** on a connection when agents need exact file contents and command output. Token counts are those 9Router reports; 9Router adds a fixed buffer of about 2,000 tokens to the reported input.

Provider error references: [OpenAI](https://developers.openai.com/api/docs/guides/error-codes), [Anthropic](https://platform.claude.com/docs/en/api/errors), and [xAI](https://docs.x.ai/developers/debugging).
