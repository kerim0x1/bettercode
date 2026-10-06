# How BetterC0de works

[Home](README.md) · [Getting started](GETTING_STARTED.md) · [Website](https://betterc0de.com)

**BetterC0de connects AI coding tools with the workspace where their changes happen.** You can discuss a task, inspect files, use a terminal, preview the result, and review differences without moving between separate applications.

## The pieces of your workspace

| Concept | Meaning |
| --- | --- |
| **Project** | The folder or repository you are working on. It gives files, tools, and conversations a shared context. |
| **Provider** | The service or coding tool that runs your AI requests. Its account and configuration determine access. |
| **Model** | The AI model available through your selected provider. |
| **Conversation** | A task's messages and activity, which you can return to as the work develops. |
| **Diff** | A comparison showing what changed in your files. |
| **Preview** | A view of your running web project inside BetterC0de. |
| **Worktree** | A separate checkout of a Git repository, useful when tasks need independent branches and files. |

## Choose the view that fits the task

### Editor: understand and refine

Use Editor when files are the center of the task. Explore the project tree, search for text, edit files, and keep chat beside your work. Open a changed file from the Diff view to inspect the comparison in the editor.

The project tree loads folders as you open them. Large projects do not share one file-count limit; a very large individual folder offers **Load more files**. The header shows how many entries have loaded, and refreshing updates opened folders while keeping their contents visible. **Reveal in Explorer** loads the necessary parent folders automatically.

### Agent: discuss and delegate

Use Agent when you want to focus on AI conversations and task progress. Arrange panes for the chats, terminals, plans, and changes you need to follow.

Multiple conversations can work with the same repository. Keep their responsibilities clear: separate chats alone do not isolate their file changes. Use separate worktrees when tasks need independent checkouts.

The **Orchestration** icon with connected nodes sits immediately left of the chat's permissions control. Open its compact menu to see the main model, enable experimental delegation, and choose agent models from the provider dropdowns. Each selected model has the same thinking slider as the chat; **Auto** uses that model's provider default. The icon indicates whether orchestration is on, and the menu shows the selection count. Above the composer controls, selected models form an overlapping group with each logo and model name visible. Hover or focus a model to see its thinking level and colored level icon; Escape closes the tooltip. You can change the selection between turns. The **+** menu holds file attachments.

### Canvas: see the project in context

Use Canvas to arrange projects and their previews on a shared visual surface. Explore desktop, tablet, and mobile layouts, inspect runtime information, and keep a project's conversation near its preview.

In browser previews, **Select** lets you pick elements and attach visual context to a request. **Browse** restores normal interaction with the page. Live style adjustments are preview changes; use **Send to AI** to ask for corresponding edits to project files.

## A practical working rhythm

1. **Describe the outcome.** Give the agent the goal, relevant context, and constraints.
2. **Follow the work.** Read its responses and review requested permissions.
3. **Inspect the result.** Look at the files, diffs, and running preview.
4. **Refine and save.** Request adjustments, check the behavior, and commit the changes you want to keep.

## Local workspace, connected services

BetterC0de runs as a desktop app and works with files on your computer. Connected AI providers may receive prompts, file context, and tool output as part of their operation. Their own terms and data policies apply.

Remote access can pair another device with the running desktop app over your network. The desktop must remain running and reachable for that connection to work.

## Diagnostics and data

The current desktop implementation includes the following diagnostic requests to BetterC0de:

| Request | When it happens | Information included |
| --- | --- | --- |
| **Heartbeat** | Every 25 seconds while the app is running, starting after the timer's first interval | A persistent random installation ID, app version, operating-system platform, and processor architecture. |
| **Manual bug report** | When you select Send Report in the Console's Report tab | Report text, available error details and stack trace, recent logs, installation ID, app version, platform, architecture, and available device information. |
| **Automatic error report** | For captured unhandled errors and supported renderer crash events | Available error details, stack trace, recent logs, and the same installation and device context used by bug reports. |

Device information can include the OS version and build, CPU model and logical core count, graphics adapter and driver information, total and used system RAM, and memory measurements for Electron processes. Some fields may be unavailable on a particular device. App memory figures do not include every external tool or child process.

The heartbeat itself contains no project files or conversation text. Error reports can contain sensitive information through their messages, stack traces, or logs. The installation ID links requests from the same app profile; it is randomly generated rather than taken from a hardware serial number.

Manual and automatic reports share a 10-second cooldown. Reporting is best effort: an unavailable network or a sudden process termination can prevent delivery. Not every crash can be captured.

See the website's [terms and data information](https://betterc0de.com/terms#data) for published policies. This section explains the current app behavior; it does not make claims about server-side retention.

## Usage overview

Open **Usage** from the sidebar to review Claude Code or Codex activity. Choose a provider from the dropdown to see lifetime statistics, recorded limits, daily activity, and usage drivers. The dropdown uses the providers' logos, and the overview follows your selected appearance. Limits show when they were last checked; local activity may not include other devices.

**API cost equivalent** estimates the value of recorded usage at model API rates. Its four cards show input, output, cache-read, and cache-write costs and their share of the estimate. Token coverage shows how much usage has a known price; pricing details identify missing model rates and custom rates. This is a cost comparison, not your subscription bill.

Recent reports remain available when you leave and reopen the page. **Refresh** reads the stores again while keeping the previous numbers visible. The first scan of a large history or a fresh provider limit check may take longer; later scans reuse unchanged files. Grok is not included in this overview.

## Availability and provider costs

BetterC0de is in beta. Check the [official website](https://betterc0de.com) for available installers and release information. Features and provider compatibility can change between versions.

AI usage is governed by your chosen provider's account, plan, and limits. Connecting a provider does not make its paid usage free.
