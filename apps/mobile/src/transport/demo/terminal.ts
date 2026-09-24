import {
  TERMINAL_CHANNELS,
  TERMINAL_METHODS,
  terminalAckParamsSchema,
  terminalAttachParamsSchema,
  terminalCloseParamsSchema,
  terminalOpenParamsSchema,
  terminalResizeParamsSchema,
  terminalWriteParamsSchema,
  type TerminalSummary,
} from "@betterc0de/schema/remote-terminal"
import type { z } from "zod"
import { RemoteCallError } from "../live/socket"

/** What the demo's shell needs from the demo desktop. */
export interface DemoShellWorld {
  /** The demo's workspaces: a terminal opens only in one of them. */
  roots(): string[]
  /** The names in a folder, folders with a trailing "/". */
  list(path: string): string[]
  now(): Date
}

interface DemoTerminal {
  readonly id: string
  readonly cwd: string
  readonly openedAt: string
  status: "running" | "exited"
  seq: number
  nextInputSeq: number
  /** The line typed so far. */
  line: string
  /** Everything sent, for a phone that attaches again. */
  readonly sent: Array<{ seq: number; frame: unknown }>
}

/** Frames kept for a phone that attaches again. */
const KEPT_FRAMES = 500

/**
 * The demo's terminal: a small pretend shell (help, ls, pwd, echo with
 * `$((…))`, whoami, date, clear, exit) that speaks the desktop's terminal
 * protocol (@betterc0de/schema/remote-terminal): numbered output a phone
 * can attach to again, input applied once and in order, the same refusals.
 * It runs nothing.
 */
export class DemoTerminals {
  private readonly terminals = new Map<string, DemoTerminal>()
  private opened = 0

  constructor(
    private readonly world: DemoShellWorld,
    private readonly emit: (frame: unknown) => void
  ) {}

  handle(method: string, params: unknown): unknown {
    switch (method) {
      case TERMINAL_METHODS.open:
        return this.open(parse(terminalOpenParamsSchema, params))
      case TERMINAL_METHODS.attach: {
        const { terminalId, afterSeq } = parse(
          terminalAttachParamsSchema,
          params
        )
        const terminal = this.owned(terminalId)
        for (const { seq, frame } of terminal.sent) {
          if (seq > afterSeq) this.later(frame)
        }
        return this.summary(terminal)
      }
      case TERMINAL_METHODS.write: {
        const { terminalId, inputSeq, data } = parse(
          terminalWriteParamsSchema,
          params
        )
        const terminal = this.owned(terminalId)
        if (inputSeq < terminal.nextInputSeq) return { applied: false }
        if (inputSeq > terminal.nextInputSeq) {
          throw new RemoteCallError(
            `Input ${inputSeq} came before input ${terminal.nextInputSeq}.`,
            "terminal_input_gap"
          )
        }
        if (terminal.status !== "running") {
          throw new RemoteCallError(
            "The terminal has ended.",
            "terminal_exited"
          )
        }
        terminal.nextInputSeq += 1
        this.type(terminal, data)
        return { applied: true }
      }
      case TERMINAL_METHODS.resize:
        this.owned(parse(terminalResizeParamsSchema, params).terminalId)
        return { ok: true }
      case TERMINAL_METHODS.ack:
        this.owned(parse(terminalAckParamsSchema, params).terminalId)
        return { ok: true }
      case TERMINAL_METHODS.close: {
        const terminal = this.owned(
          parse(terminalCloseParamsSchema, params).terminalId
        )
        this.terminals.delete(terminal.id)
        this.later({
          channel: TERMINAL_CHANNELS.closed,
          data: { terminalId: terminal.id, reason: "closed" },
        })
        return { ok: true }
      }
      case TERMINAL_METHODS.list:
        return {
          terminals: [...this.terminals.values()].map((terminal) =>
            this.summary(terminal)
          ),
        }
      default:
        throw new RemoteCallError("Unknown RPC method", "unknown_method")
    }
  }

  private open(
    params: z.infer<typeof terminalOpenParamsSchema>
  ): TerminalSummary {
    const cwd = this.world
      .roots()
      .find((root) => root === params.cwd || params.cwd.startsWith(`${root}/`))
    if (!cwd) {
      throw new RemoteCallError(
        "workspace root is not registered",
        "workspace_not_registered"
      )
    }
    this.opened += 1
    const terminal: DemoTerminal = {
      id: `demo-terminal-${this.opened}`,
      cwd: params.cwd,
      openedAt: this.world.now().toISOString(),
      status: "running",
      seq: 0,
      nextInputSeq: 1,
      line: "",
      sent: [],
    }
    this.terminals.set(terminal.id, terminal)
    this.print(
      terminal,
      "BetterC0de demo shell: it runs nothing. Try ls, pwd, echo $((6*7)) or help.\r\n"
    )
    this.prompt(terminal)
    return this.summary(terminal)
  }

  private owned(terminalId: string): DemoTerminal {
    const terminal = this.terminals.get(terminalId)
    if (!terminal) {
      throw new RemoteCallError("Terminal not found.", "terminal_not_found")
    }
    return terminal
  }

  private summary(terminal: DemoTerminal): TerminalSummary {
    return {
      terminalId: terminal.id,
      cwd: terminal.cwd,
      shell: "demo",
      status: terminal.status,
      openedAt: terminal.openedAt,
      nextInputSeq: terminal.nextInputSeq,
    }
  }

  /** Keys as a line discipline takes them: echoed, and run on Enter. */
  private type(terminal: DemoTerminal, data: string): void {
    const keys = withoutEscapeSequences(data)
    let echo = ""
    for (const key of keys) {
      if (terminal.status !== "running") break
      if (key === "\r" || key === "\n") {
        this.print(terminal, `${echo}\r\n`)
        echo = ""
        const line = terminal.line
        terminal.line = ""
        this.run(terminal, line.trim())
        if (terminal.status === "running") this.prompt(terminal)
      } else if (key === "\x7f" || key === "\b") {
        if (terminal.line) {
          terminal.line = terminal.line.slice(0, -1)
          echo += "\b \b"
        }
      } else if (key === "\x03") {
        this.print(terminal, `${echo}^C\r\n`)
        echo = ""
        terminal.line = ""
        this.prompt(terminal)
      } else if (key === "\x0c") {
        this.print(terminal, `${echo}\x1b[2J\x1b[H`)
        echo = ""
        this.prompt(terminal)
        echo += terminal.line
      } else if (key >= " ") {
        terminal.line += key
        echo += key
      }
    }
    if (echo) this.print(terminal, echo)
  }

  private run(terminal: DemoTerminal, line: string): void {
    if (!line) return
    const [command = ""] = line.split(/\s+/)
    const say = (text: string) => this.print(terminal, `${text}\r\n`)
    switch (command) {
      case "help":
        say("Commands: ls, pwd, echo, whoami, date, clear, exit.")
        return
      case "ls":
        say(this.world.list(terminal.cwd).join("  "))
        return
      case "pwd":
        say(terminal.cwd)
        return
      case "whoami":
        say("demo")
        return
      case "date":
        say(this.world.now().toUTCString())
        return
      case "clear":
        this.print(terminal, "\x1b[2J\x1b[H")
        return
      case "echo":
        say(expandArithmetic(line.slice(line.indexOf("echo") + 4).trim()))
        return
      case "exit":
        terminal.status = "exited"
        terminal.seq += 1
        this.send(terminal, {
          channel: TERMINAL_CHANNELS.exit,
          data: {
            terminalId: terminal.id,
            seq: terminal.seq,
            exitCode: 0,
            signal: null,
          },
        })
        return
      default:
        say(`demo: command not found: ${command}`)
    }
  }

  private prompt(terminal: DemoTerminal): void {
    const name = terminal.cwd.split("/").filter(Boolean).at(-1) ?? "demo"
    this.print(terminal, `\x1b[32m${name}\x1b[0m % `)
  }

  private print(terminal: DemoTerminal, output: string): void {
    terminal.seq += 1
    this.send(terminal, {
      channel: TERMINAL_CHANNELS.output,
      data: { terminalId: terminal.id, seq: terminal.seq, output },
    })
  }

  private send(terminal: DemoTerminal, frame: unknown): void {
    terminal.sent.push({ seq: terminal.seq, frame })
    if (terminal.sent.length > KEPT_FRAMES) terminal.sent.shift()
    this.later(frame)
  }

  /** After the call's answer, as from the desktop. */
  private later(frame: unknown): void {
    setTimeout(() => this.emit(frame), 0)
  }
}

const ESCAPE = "\u001b"

/**
 * The keys without cursor and function keys (`ESC [ … letter`, `ESC O
 * letter`) or a lone Esc: the pretend shell has no line editing.
 */
function withoutEscapeSequences(data: string): string {
  let keys = ""
  for (let index = 0; index < data.length; index += 1) {
    if (data[index] !== ESCAPE) {
      keys += data[index]
      continue
    }
    if (data[index + 1] === "[") {
      index += 2
      while (index < data.length && "0123456789;".includes(data[index]!))
        index += 1
    } else if (data[index + 1] === "O") {
      index += 2
    }
  }
  return keys
}

function parse<T extends z.ZodType>(schema: T, params: unknown): z.infer<T> {
  const result = schema.safeParse(params)
  if (!result.success) {
    throw new RemoteCallError("Invalid terminal request.", "invalid_params")
  }
  return result.data
}

/** `$((6*7))` in an echo becomes 42, as a shell's arithmetic would. */
export function expandArithmetic(text: string): string {
  return text.replace(
    /\$\(\(([^()]*(?:\([^()]*\)[^()]*)*)\)\)/g,
    (whole, expression: string) => {
      const value = evaluateArithmetic(expression)
      return value === null ? whole : String(value)
    }
  )
}

/**
 * Integer arithmetic with + - * / % and parentheses, as `$((…))` has it;
 * null for anything else, or a division by zero. Parsed, never evaluated
 * as code.
 */
export function evaluateArithmetic(expression: string): number | null {
  const tokens = expression.replace(/\s+/g, "").match(/\d+|[-+*/%()]/g) ?? []
  if (tokens.join("") !== expression.replace(/\s+/g, "") || !tokens.length)
    return null
  let position = 0
  const peek = () => tokens[position]
  const next = () => tokens[position++]
  function factor(): number | null {
    const token = next()
    if (token === "-") {
      const value = factor()
      return value === null ? null : -value
    }
    if (token === "(") {
      const value = sum()
      return next() === ")" ? value : null
    }
    return token !== undefined && /^\d+$/.test(token) ? Number(token) : null
  }
  function product(): number | null {
    let value = factor()
    while (
      value !== null &&
      (peek() === "*" || peek() === "/" || peek() === "%")
    ) {
      const operator = next()
      const right = factor()
      if (right === null) return null
      if (operator === "*") value *= right
      else if (right === 0) return null
      else value = operator === "/" ? Math.trunc(value / right) : value % right
    }
    return value
  }
  function sum(): number | null {
    let value = product()
    while (value !== null && (peek() === "+" || peek() === "-")) {
      const operator = next()
      const right = product()
      if (right === null) return null
      value = operator === "+" ? value + right : value - right
    }
    return value
  }
  const value = sum()
  return position === tokens.length ? value : null
}
