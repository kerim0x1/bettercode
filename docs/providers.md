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

Key health is kept in memory and refreshed while the settings screen is open. Restarting the backend clears that health history. Removed or replaced credentials cannot update their replacement's status when an older request finishes.

## Models and CLI accounts

Account model lists come from the provider API and stay cached separately for each credential. **Refresh models** reloads them; **Visible Models** controls which IDs appear in the picker, and **Custom Models** accepts an additional model ID. Model access still depends on the account and selected key.

Direct API billing is separate from a ChatGPT, Claude, or Grok subscription. Subscription logins remain under the existing CLI account entries. API-key management does not change the CLI harness, approvals, permissions, or tools.

Provider error references: [OpenAI](https://developers.openai.com/api/docs/guides/error-codes), [Anthropic](https://platform.claude.com/docs/en/api/errors), and [xAI](https://docs.x.ai/developers/debugging).
