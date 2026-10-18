# Getting started with BetterC0de

[Home](README.md) · [Product guide](PRODUCT_GUIDE.md) · [Website](https://betterc0de.com)

Get from installation to your first reviewed change. This guide describes the desktop app without build instructions or terminal commands.

## 1. Get the app

Download the installer for your computer, run it, follow its prompts, and open BetterC0de.

| Platform | Download |
| --- | --- |
| Windows 10 / 11 (64-bit) | [betterc0de.com/download?os=win](https://betterc0de.com/download?os=win) |
| macOS — Apple Silicon (M1 or newer) | [betterc0de.com/download?os=mac&arch=arm64](https://betterc0de.com/download?os=mac&arch=arm64) |
| macOS — Intel | [betterc0de.com/download?os=mac&arch=x64](https://betterc0de.com/download?os=mac&arch=x64) |
| Linux | Coming soon |

[betterc0de.com/download](https://betterc0de.com/download) without parameters detects your system and serves the matching build. On a Mac, **About This Mac** identifies the processor: an "Apple M…" chip is Apple Silicon, anything else is Intel.

**Windows:** SmartScreen may warn about an unrecognized publisher while the beta is unsigned — choose *More info → Run anyway*.
**macOS:** Signed and notarized releases open normally. If macOS says that Apple could not verify BetterC0de is free of malware (an unsigned beta), open **System Settings → Privacy & Security** and choose **Open Anyway**.

## 2. Connect a provider

Open **Settings → Providers** to see the providers available in your installation.

BetterC0de can detect supported coding CLIs already installed on your computer. A CLI is a provider's command-line coding tool. If you already use one and have signed in, BetterC0de can use that existing setup where supported. Other provider connections may require an API key.

Select the connection you want to use and follow the instructions shown. For provider-specific setup, use the provider's own website:

| Provider | Official website |
| --- | --- |
| Claude Code | [Claude Code](https://claude.com/product/claude-code) |
| OpenAI Codex | [OpenAI Codex](https://openai.com/codex/) |
| Cursor | [Cursor](https://cursor.com) |
| Grok | [xAI](https://x.ai) |

Available models and capabilities depend on your connection and account. BetterC0de does not replace the provider's subscription, usage limits, or API billing.

## 3. Open your project

Open the folder containing your project. Check that the file tree shows the files you expect before starting a task.

Choose **Editor** for a familiar files-and-chat layout, **Agent** to focus on conversations, or **Canvas** to organize projects and previews visually. You can change modes as you work.

## 4. Give your agent a clear first task

Select an available provider and model, then describe your goal. Include the result you want and any constraints that matter.

For a first conversation, try:

> Explain how this project is organized, identify its main entry points, and suggest a small improvement. Wait for me to choose before editing files.

For a visual task, try:

> Make this page easier to use on mobile. Keep the existing branding and explain which parts you changed.

Review permission requests before approving them. Start a separate conversation when moving to an unrelated task so its context stays clear.

## 5. Inspect the result

Open changed files in the editor and use **Diff** or **Git** to review the changes. For a web project, open its preview after its development server is running and check the relevant interactions.

If something needs adjustment, describe the remaining issue in the same conversation. Commit changes when you are satisfied with the result.

## When something does not work

| What you see | What to check |
| --- | --- |
| A provider is missing | Confirm that its supported tool is installed and signed in, then reopen BetterC0de and check Providers. |
| A model cannot respond | Check the provider connection, internet access, and the account's available usage. |
| A preview is empty | Check that the project's development server is running and that the preview uses its address. |
| The agent is looking at the wrong files | Check the active project folder and the conversation's project context. |
| A feature behaves unexpectedly | Note the steps that reproduce it and send a report from the Console's Report tab. |

## Send useful feedback

Open **Console → Report** and select **Send Report**. Wait for the result; another submission is available after the 10-second cooldown. **Copy Report** copies the visible report for sharing.

When contacting support, explain what you were doing, what you expected, and what happened instead. Reports can include logs and device information; the [product guide](PRODUCT_GUIDE.md#diagnostics-and-data) explains what is sent. Review copied logs before posting them publicly.

For questions and feedback, visit the [Discord community](https://discord.gg/bettercode).
