/**
 * One slash command family: the names it answers to (without the leading
 * slash) and what it does.
 *
 * `when` narrows a spec to some arguments, such as `/mcp add`. When several
 * specs share a name, the first registered one whose `when` passes handles the
 * command, so registration order is precedence.
 */
export interface SlashCommandSpec<TContext, TResult> {
  readonly names: readonly string[]
  readonly when?: (context: TContext) => boolean
  readonly run: (context: TContext) => TResult
}

export type SlashCommandIndex<TContext, TResult> = ReadonlyMap<
  string,
  readonly SlashCommandSpec<TContext, TResult>[]
>

export function indexSlashCommands<TContext, TResult>(
  specs: readonly SlashCommandSpec<TContext, TResult>[]
): SlashCommandIndex<TContext, TResult> {
  const index = new Map<string, SlashCommandSpec<TContext, TResult>[]>()
  for (const spec of specs) {
    for (const name of new Set(spec.names)) {
      const command = `/${name}`
      const registered = index.get(command)
      if (registered) registered.push(spec)
      else index.set(command, [spec])
    }
  }
  return index
}

export function findSlashCommand<TContext, TResult>(
  command: string,
  context: TContext,
  index: SlashCommandIndex<TContext, TResult>
): SlashCommandSpec<TContext, TResult> | undefined {
  return index.get(command)?.find((spec) => !spec.when || spec.when(context))
}

export function dispatchSlashCommand<TContext, TResult>(
  command: string,
  context: TContext,
  index: SlashCommandIndex<TContext, TResult>
): TResult | undefined {
  const spec = findSlashCommand(command, context, index)
  return spec ? spec.run(context) : undefined
}

/** Every registered name, in registration order and without duplicates. */
export function slashCommandNames(
  specs: readonly { readonly names: readonly string[] }[]
): string[] {
  return [...new Set(specs.flatMap((spec) => spec.names))]
}
