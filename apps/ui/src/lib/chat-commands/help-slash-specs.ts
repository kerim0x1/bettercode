import { betterC0deShareModeFromProjectSettings } from "@/lib/betterc0de-share-policy"
import type { WorkspaceProjectConfigSetting } from "@/services/backend/workspaceApi"
import { formatProjectToolState } from "./project-config-commands"
import type { SlashCommandRunSpec, SlashCommandRuntimeRun } from "./slash-run"

function shareCommandHelpRows(
  settings: ReadonlyArray<WorkspaceProjectConfigSetting>
): string[] {
  if (betterC0deShareModeFromProjectSettings(settings) === "disabled") return []
  return [
    "| `/share` | Copy a local markdown export of this chat |",
    "| `/unshare` | Remove this chat's local share marker |",
  ]
}

/** The `/help` overview, including the loaded runtime and project lists. */
export const HELP_SLASH_SPECS: readonly SlashCommandRunSpec<SlashCommandRuntimeRun>[] =
  [
    {
      names: ["help", "help.show", "help-show"],
      run: (run) => {
        const {
          selectedProvider,
          mcpList,
          skillList,
          subagentList,
          projectCommandList,
          projectReferenceList,
          projectFormatterList,
          projectLspServerList,
          projectPermissionList,
          projectConfigList,
          projectProvidersSummary,
          projectPluginList,
          projectToolList,
        } = run
        const sections: string[] = [
          "# BetterC0de Commands\n",
          "**Built-in**\n",
          "| Command | What it does |",
          "|:--------|:-------------|",
          "| `/plan [prompt]` | Switch this thread into plan mode |",
          "| `/ask [prompt]` | Switch this thread into read-only ask mode |",
          "| `/security [prompt]` | Switch this thread into security review mode |",
          "| `/debug [prompt]` | Switch this thread into debug mode |",
          "| `/default`, `/build`, `/agent-mode` | Return this thread to normal build mode |",
          "| `/agent`, `/agent.cycle` | Cycle the selected BetterC0de compatibility provider agent |",
          "| `/model`, `/models` | Open the model picker |",
          "| `/command-palette`, `/command.palette.show` | Open the command palette |",
          "| `/model-next`, `/model-previous`, `/favorite-next`, `/favorite-previous` | Cycle models without opening the picker |",
          "| `/favorite-toggle`, `/model.dialog.favorite` | Toggle the current model as favorite |",
          "| `/sessions`, `/session.list --format json`, `/resume`, `/continue` | List or resume recent chats |",
          "| `/session.next`, `/session.previous` | Navigate recent chats like BetterC0de app commands |",
          "| `/new`, `/clear` | Start a new chat session |",
          "| `/project.open`, `/project.next`, `/project.previous` | Open or navigate projects represented by chats |",
          "| `/workspace.new`, `/workspace.toggle`, `/workspace.list`, `/workspace.remove`, `/workspace.reset` | Create, inspect, list, remove, or reset isolated worktree workspace state |",
          "| `/init [focus]` | Create or update repo-local `AGENTS.md` instructions |",
          "| `/review [commit|branch|pr]`, `/pr <number>` | Review uncommitted changes, a commit, branch, or PR |",
          "| `/github`, `/github.install`, `/github.run` | Show BetterC0de GitHub agent setup and run guidance; `/github.install --workflow-only --provider <provider> --model <model>` writes the workflow file |",
          "| `/commands`, `/project-commands` | List repo-local command templates and config commands; add `--config-only` to write a config command |",
          "| `/references`, `/refs` | List configured BetterC0de project references; add `--config-only` to write an alias |",
          "| `/format <file> [formatter] [--dry-run|--terminal]` | Run or preview a BetterC0de project formatter |",
          "| `/formatters` | List BetterC0de project formatter config; add `--config-only` to write a formatter entry |",
          "| `/lsp`, `/lsps`, `/debug.lsp` | List BetterC0de project LSP server config; add `--config-only` to write an LSP entry |",
          "| `/lsp diagnostics <file> [--json]`, `/lsp symbols <query> [--json]`, `/lsp document-symbols <uri> [--json]` | Show BetterC0de LSP debug guidance and local JSON previews |",
          "| `/permissions` | List BetterC0de project permission rules; add `--config-only` to write explicit permission config |",
          "| `/approvals` | List pending provider/BetterC0de approval requests |",
          "| `/approve <#|id>`, `/deny <#|id>` | Reply to a pending approval request |",
          "| `/todos`, `/tasks`, `/session.todo` | Show the current BetterC0de session todo list |",
          "| `/betterc0de-config`, `/project-config`, `/debug.config` | Show BetterC0de project config summary |",
          "| `/betterc0de-audit`, `/betterc0de-parity` | Show BetterC0de feature-area compatibility coverage |",
          "| `/betterc0de-cli`, `/betterc0de.commands` | Show command-by-command BetterC0de compatibility coverage |",
          "| `/betterc0de-api`, `/betterc0de.api` | Show BetterC0de HTTP/API compatibility coverage |",
          "| `/betterc0de-gaps`, `/betterc0de.missing` | Show partial and display-only BetterC0de compatibility gaps |",
          "| `/betterc0de-sync`, `/sync.history.list` | Show BetterC0de sync compatibility and validation |",
          "| `/betterc0de-workspace`, `/experimental.workspace.warp` | Show BetterC0de workspace sync/warp compatibility |",
          "| `/betterc0de-lifecycle`, `/global.dispose` | Show BetterC0de lifecycle compatibility |",
          "| `/tui-control`, `/tui.control.next` | Show BetterC0de terminal control compatibility |",
          "| `/tui`, `/keybinds`, `/which-key` | Show BetterC0de terminal UI config, keybind overrides, and defaults; add `--config-only` to write safe `tui.json` settings |",
          "| `/tips` | Show BetterC0de workflow tips |",
          "| `/theme.cycle`, `/theme.scheme.cycle`, `/language.cycle` | BetterC0de app command compatibility |",
          "| `/attachments`, `/tool-output`, `/compaction` | Show BetterC0de runtime limits and context controls; add `--config-only` to write safe limit settings |",
          "| `/betterc0de-runtime` | Show BetterC0de shell, server, watcher, limits, share, enterprise, and app settings; add `--config-only` to write runtime config |",
          "| `/betterc0de-tui`, `/betterc0de-run`, `/betterc0de-serve`, `/betterc0de-web`, `/betterc0de-acp` | Show BetterC0de runtime compatibility entrypoint guidance; add `--terminal` to prefill the integrated terminal |",
          "| `/betterc0de-upgrade`, `/betterc0de-uninstall`, `/betterc0de-generate`, `/betterc0de-completion`, `/betterc0de-db`, `/db.query` | Show BetterC0de maintenance/database compatibility guidance; add `--terminal` to prefill the integrated terminal |",
          "| `/project-providers` | Show BetterC0de project provider, model, and auth config |",
          "| `/project-plugins` | Show BetterC0de project plugin specs |",
          "| `/project-tools` | Show BetterC0de project tool flags and custom tool modules; add `--config-only` to write legacy tool flags |",
          "| `/undo [turn]` | Restore the previous checkpoint, or a specific checkpoint turn |",
          "| `/redo` | Reapply the last checkpoint undo |",
          "| `/interrupt`, `/stop`, `/cancel` | Interrupt the active provider turn |",
          "| `/fork` | Fork this chat into an independent session |",
          "| `/parent`, `/child [id|title]`, `/child-next`, `/child-previous` | Navigate forked chat session branches |",
          "| `/pin`, `/pins`, `/quick-switch <1-9>` | Pin sessions and jump to BetterC0de-compatible pinned slots |",
          "| `/archive`, `/unarchive`, `/archives`, `/delete-session --yes` | Archive, restore, inspect, or permanently delete sessions |",
          ...shareCommandHelpRows(projectConfigList),
          "| `/copy` | Copy this chat transcript to the clipboard |",
          "| `/copy-last`, `/copy-assistant`, `/copy-message` | Copy the latest assistant message to the clipboard |",
          "| `/export [file.md]`, `/export --json [file.json]` | Export this chat transcript into the workspace; add `--terminal` for raw `betterc0de export` |",
          "| `/import <file.json|url>`, `/session.import <file.json|url>` | Import a BetterC0de JSON session or compatibility share data; add `--terminal` for raw `betterc0de import` |",
          "| `/diff [--full]`, `/session.diff` | Show the active chat session diff summary |",
          "| `/rename <title>`, `/title <title>` | Rename the active chat session |",
          "| `/timeline` | Show a compact timeline of this chat session |",
          "| `/messages [--limit 20] [--order asc|desc] [--cursor n]`, `/session.message.list` | Page through chat messages |",
          "| `/context [--full]`, `/session.context` | Inspect active chat context after the last compaction |",
          "| `/vcs`, `/vcs diff`, `/vcs raw`, `/vcs.apply [patch.diff]` | Show BetterC0de-compatible VCS status, diff, or patch-apply guidance |",
          "| `/history`, `/history-use [#|id]` | Show or restore BetterC0de-compatible prompt history |",
          "| `/prompt-clear`, `/prompt-paste`, `/prompt-submit` | BetterC0de prompt controls |",
          "| `/stash <prompt>` | Save prompt text to the BetterC0de-compatible prompt stash |",
          "| `/stashes`, `/stash-pop [#|id]`, `/stash-delete <#|id>` | List, restore, or delete stashed prompts |",
          "| `/first`, `/last`, `/last-user`, `/next-message`, `/previous-message` | Navigate chat messages without sending to the model |",
          "| `/page-up`, `/page-down`, `/half-page-up`, `/half-page-down`, `/line-up`, `/line-down` | Scroll the chat transcript without sending to the model |",
          "| `/open [path[:line[:column]]]`, `/editor` | Open Quick Open or a workspace file in Editor Mode |",
          "| `/add-selection`, `/context.addSelection` | Add the active editor selection to the composer context |",
          "| `/close`, `/close-tab` | Close the active editor tab |",
          "| `/warp [folder]`, `/workspace [folder]` | Change the workspace for this chat |",
          "| `/mode-next`, `/mode-previous` | Cycle between Agent, Plan, Ask, Security, and Debug modes |",
          "| `/exit`, `/quit`, `/q` | Close the BetterC0de window |",
          "| `/help` | Show this overview |",
          "| `/mcps`, `/mcp.list` | Show installed MCP servers with connection details |",
          "| `/mcp-resources`, `/experimental.resource.list` | Show BetterC0de-compatible MCP resource availability |",
          "| `/mcp-auth`, `/mcp.auth.list` | Show OAuth authentication status for MCP servers |",
          "| `/mcp-add`, `/mcp-logout`, `/mcp-debug <id>` | BetterC0de MCP add/logout/debug compatibility; add `--config-only` to write project MCP config |",
          "| `/mcp-toggle <id> [on|off]` | Enable or disable an installed MCP server; add `--config-only` to write a project override |",
          "| `/skills`, `/debug.skill` | Show installed skills and their content; add `--config-only` to add compatibility skill paths or URLs |",
          "| `/agents`, `/debug.agent` | Show configured subagents and BetterC0de-compatible details; add `--terminal` for `betterc0de agent list` / `betterc0de debug agent` |",
          "| `/agent-create`, `/agent.create` | Show BetterC0de agent create guidance; add `--terminal` to prefill raw `betterc0de agent create` |",
          "| `/instructions`, `/project-rules` | Show injected project rules and BetterC0de instructions; add `--config-only` to add instruction file globs |",
          "| `/status` | Show system status overview |",
          "| `/debug-info`, `/debug.info` | Show BetterC0de-compatible app, OS, and runtime diagnostics |",
          "| `/debug-paths`, `/debug.paths`, `/db.path` | Show BetterC0de data paths and SQLite database path |",
          "| `/debug-rg [files|read|search|tree]`, `/debug.file.[status|list|read|search|tree]`, `/file.[status|list|read]` | Run read-only BetterC0de-compatible workspace file/search diagnostics |",
          "| `/debug-snapshot [track|patch|diff]` | Show read-only BetterC0de-compatible snapshot/checkpoint diagnostics |",
          "| `/debug-startup`, `/debug-scrap`, `/debug-v2`, `/debug-wait` | Show BetterC0de debug guidance |",
          "| `/stats`, `/usage` | Show BetterC0de-compatible token, model, and tool usage statistics |",
          "| `/plugin-install <module>`, `/plugin <module>`, `/plug <module>` | Show BetterC0de plugin install guidance |",
          "| `/plugin-toggle <id> --enabled true --config-only` | Persist BetterC0de terminal UI `plugin_enabled` state |",
          "| `/compact` | Compact this chat into a thread summary |",
          "| `/docs` | Open BetterC0de documentation |",
          "| `/settings [tab]` | Open Settings (`general`, `providers`, `appearance`, `rules`, `skills`, `tools`, `hooks`, `plugins`, `betterc0de`, `docs`) |",
          "| `/org`, `/organization` | Open provider account and organization settings; add `--terminal` for `betterc0de console orgs/switch` |",
          "| `/console`, `/app.debug` | Toggle the console/debug panel |",
          "| `/app.log [level] <message>` | Write an BetterC0de-compatible local log entry |",
          "| `/heap-snapshot`, `/app.heap_snapshot` | Write a Node backend heap snapshot to the logs directory |",
          "| `/terminal`, `/terminal.suspend` | Toggle the terminal panel |",
          "| `/terminal-title`, `/terminal.title.toggle` | Toggle integrated terminal tab titles |",
          "| `/terminal-new`, `/terminal.new` | Open the terminal panel and create a new terminal session |",
          "| `/review.toggle` | Toggle the review/diff panel |",
          "| `/fileTree.toggle`, `/files` | Toggle the workspace file tree |",
          "| `/sidebar` | Toggle the main app sidebar |",
          "| `/input.focus` | Focus the chat input |",
          "| `/animations`, `/file-context`, `/session-directory-filter` | Toggle BetterC0de-compatible app behavior flags |",
          "| `/connect`, `/providers.login`, `/account.login`, `/console.login` | Show provider connection guidance; add `--terminal` to prefill the BetterC0de auth command |",
          "| `/auth`, `/auth.list`, `/account.logout`, `/providers.logout` | Show provider authentication and setup status; add `--terminal` for logout/list commands |",
          "| `/themes`, `/theme <dark|light>` | List or switch themes |",
          "| `/theme-mode`, `/theme.switch_mode`, `/theme-mode-lock` | Switch or lock the light/dark theme mode |",
          "| `/terminal-font [font|system]` | Show or set the integrated terminal font |",
          "| `/variants`, `/variant.list` | Show model variant support |",
          "| `/variant.cycle`, `/model.variant.cycle` | Cycle the current BetterC0de model variant |",
          "| `/catalog [model|provider]`, `/models <query> --verbose`, `/catalog.model.list` | Inspect provider model catalog metadata |",
          "| `/streaming [on|off]` | Toggle assistant response streaming |",
          "| `/timestamps [on|off]`, `/toggle-timestamps [on|off]` | Toggle chat message timestamps |",
          "| `/thinking [on|off]`, `/toggle-thinking [on|off]` | Toggle assistant thinking blocks |",
          "| `/reasoning-summaries [on|off]` | Toggle compact reasoning summary headings |",
          "| `/tool-details [on|off]`, `/actions [on|off]` | Toggle expanded tool details |",
          "| `/progress [on|off]`, `/session.toggle.progress_bar [on|off]` | Toggle BetterC0de-compatible session progress rows |",
          "| `/shell-expanded [on|off]`, `/edit-expanded [on|off]` | Toggle default expansion for shell and edit tool parts |",
          "| `/scrollbar [on|off]`, `/toggle-scrollbar [on|off]` | Toggle the main chat scrollbar |",
          "| `/generic-tool-output [on|off]` | Toggle raw output previews for generic tools |",
          "| `/conceal [on|off]`, `/session.toggle.conceal [on|off]` | Toggle concealed code block previews |",
          "| `/autosave [on|off]` | Toggle automatic conversation saving |",
          "| `/diffwrap [on|off]` | Toggle diff viewer word wrap |",
          "| `/diff-style [auto|stacked]` | Set BetterC0de-compatible diff layout |",
          "| `/notifications [request|on|off|agent|permissions|errors]` | Show or change native notification settings |",
          "| `/confirmations [on|off]` | Toggle archive and delete confirmations |",
          "| `/autoaccept [on|off]` | Toggle automatic tool approval for this chat |",
          "| `/density [on|off]`, `/compact-ui [on|off]` | Toggle compact chat spacing |",
        ]
        if (mcpList.length > 0) {
          sections.push(
            "",
            "---",
            "",
            "**MCP Servers** - Type `/<name>` to reference\n"
          )
          for (const m of mcpList)
            sections.push(
              `- \`/${m.id}\` - **${m.name}** \`${m.command}\` ${m.enabled ? "" : "(disabled)"}`
            )
        }
        const providerSlashCommands = selectedProvider?.slashCommands ?? []
        if (providerSlashCommands.length > 0) {
          sections.push(
            "",
            "---",
            "",
            `**${selectedProvider?.name ?? "Provider"} Commands** - Type \`/<command>\` to send a provider-native slash command\n`
          )
          for (const command of providerSlashCommands) {
            const name = command.name.replace(/^\/+/, "")
            sections.push(
              `- \`/${name}\`${command.description ? ` - ${command.description}` : ""}`
            )
          }
        }
        const providerSkills = (selectedProvider?.skills ?? []).filter(
          (skill) => skill.enabled
        )
        if (providerSkills.length > 0) {
          sections.push(
            "",
            "---",
            "",
            `**${selectedProvider?.name ?? "Provider"} Skills** - Type \`/\` and choose **Skills**, or use \`$<skill>\` directly. Existing commands take precedence over a typed \`/<skill>\` alias.\n`
          )
          for (const skill of providerSkills) {
            const name = skill.name.replace(/^\$+/, "")
            sections.push(
              `- \`$${name}\` - **${skill.displayName ?? skill.name}**`
            )
          }
        }
        if (skillList.length > 0) {
          sections.push(
            "",
            "---",
            "",
            "**BetterC0de Runtime Skills** - Use `/<skill-id>` to run a skill as an BetterC0de-compatible command, or `@<skill-id>` to inline one explicitly for non-native providers\n"
          )
          for (const s of skillList)
            sections.push(`- \`/${s.id}\` / \`@${s.id}\` - **${s.name}**`)
        }
        if (subagentList.length > 0) {
          sections.push(
            "",
            "---",
            "",
            "**Subagents** - Type `/<name>` to inspect or `@<subagent-id>` to inject into the prompt\n"
          )
          for (const agent of subagentList)
            sections.push(`- \`/${agent.id}\` - **${agent.name}**`)
        }
        if (projectCommandList.length > 0) {
          sections.push(
            "",
            "---",
            "",
            "**Project Commands** - Type `/<command>` to run repo-local `.betterc0de/command(s)` templates\n"
          )
          for (const command of projectCommandList) {
            sections.push(
              `- \`/${command.name}\` - **${command.description ?? command.sourcePath}**`
            )
          }
        }
        if (projectReferenceList.length > 0) {
          sections.push(
            "",
            "---",
            "",
            "**Project References** - Type `@<alias>` or `@<alias>/<path>` to point the agent at an BetterC0de reference\n"
          )
          for (const reference of projectReferenceList) {
            sections.push(
              `- \`@${reference.id}\` - **${reference.kind}** ${reference.repository ?? reference.relativePath ?? reference.message ?? reference.sourcePath}`
            )
          }
        }
        if (projectFormatterList.length > 0) {
          sections.push(
            "",
            "---",
            "",
            "**Project Formatters** - Type `/formatters` for command details\n"
          )
          for (const formatter of projectFormatterList) {
            sections.push(
              `- \`${formatter.id}\` - **${formatter.enabled ? "enabled" : "disabled"}** ${formatter.command || "built-in"}`
            )
          }
        }
        if (projectLspServerList.length > 0) {
          sections.push(
            "",
            "---",
            "",
            "**Project LSP Servers** - Type `/lsp` for command details\n"
          )
          for (const server of projectLspServerList) {
            sections.push(
              `- \`${server.id}\` - **${server.enabled ? "enabled" : "disabled"}** ${server.command || "built-in"}`
            )
          }
        }
        if (projectPermissionList.length > 0) {
          sections.push(
            "",
            "---",
            "",
            "**Project Permissions** - Type `/permissions` for rules\n"
          )
          for (const rule of projectPermissionList) {
            sections.push(
              `- \`${rule.permission}\` \`${rule.pattern}\` - **${rule.action}**`
            )
          }
        }
        if (projectConfigList.length > 0) {
          sections.push(
            "",
            "---",
            "",
            "**BetterC0de Project Config** - Type `/betterc0de` for the full summary\n"
          )
          for (const setting of projectConfigList.slice(0, 12)) {
            sections.push(`- \`${setting.key}\` - **${setting.value}**`)
          }
        }
        if (
          projectProvidersSummary &&
          (projectProvidersSummary.providers.length > 0 ||
            projectProvidersSummary.defaultModel ||
            projectProvidersSummary.enabledProviders.length > 0 ||
            projectProvidersSummary.disabledProviders.length > 0)
        ) {
          sections.push(
            "",
            "---",
            "",
            "**BetterC0de Project Providers** - Type `/project-providers` for provider and model details\n"
          )
          if (projectProvidersSummary.defaultModel) {
            sections.push(
              `- Default model: \`${projectProvidersSummary.defaultModel}\``
            )
          }
          for (const provider of projectProvidersSummary.providers) {
            sections.push(
              `- \`${provider.id}\` - **${provider.name ?? provider.id}** (${provider.models.length} model${provider.models.length === 1 ? "" : "s"})`
            )
          }
        }
        if (projectPluginList.length > 0) {
          sections.push(
            "",
            "---",
            "",
            "**BetterC0de Project Plugins** - Type `/project-plugins` for plugin specs\n"
          )
          for (const plugin of projectPluginList) {
            sections.push(
              `- \`${plugin.spec}\` - **${plugin.kind}** ${plugin.message ?? ""}`
            )
          }
        }
        if (projectToolList.length > 0) {
          sections.push(
            "",
            "---",
            "",
            "**BetterC0de Project Tools** - Type `/project-tools` for tool flags and custom tool modules\n"
          )
          for (const tool of projectToolList) {
            sections.push(
              `- \`${tool.tool}\` - **${formatProjectToolState(tool)}**`
            )
          }
        }
        run.output = sections.join("\n")
      },
    },
  ]
