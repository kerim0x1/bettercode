import { CheckIcon, FolderOpenIcon, Loader2Icon, XIcon } from "lucide-react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { assetUrl } from "@/lib/asset-url"
import { pickFolder, runShellCommand } from "@/services/backend"
import { useChatStore } from "@/lib/chat-store"

type ProjectPM = "npm" | "pnpm" | "bun" | "yarn"
type ProjectStatus = "idle" | "running" | "done" | "error"

/**
 * Multi-step wizard for scaffolding a new project.
 *
 * Steps: (0) name + path + package manager → (1) framework template → (2)
 * optional UI library + summary → (3) live log as shell commands execute.
 *
 * All scaffold/install/git-init calls go through `runShellCommand`, with
 * stdout streamed into the log pane. On success a matching thread is
 * created in the chat store so the new project is immediately active.
 *
 * Closing the dialog mid-run is blocked: `onOpenChange` only commits the
 * close when `newProjectStatus !== "running"` so we never leave orphaned
 * shell processes wondering why the UI moved on.
 */
export function NewProjectDialog({
  open,
  onOpenChange,
  minimalChat,
  newProjectStep,
  setNewProjectStep,
  newProjectStatus,
  setNewProjectStatus,
  newProjectLog,
  setNewProjectLog,
  newProjectName,
  setNewProjectName,
  newProjectPath,
  setNewProjectPath,
  newProjectPM,
  setNewProjectPM,
  newProjectTemplate,
  setNewProjectTemplate,
  newProjectUI,
  setNewProjectUI,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  minimalChat: boolean
  newProjectStep: number
  setNewProjectStep: (step: number) => void
  newProjectStatus: ProjectStatus
  setNewProjectStatus: (status: ProjectStatus) => void
  newProjectLog: string
  setNewProjectLog: (log: string | ((prev: string) => string)) => void
  newProjectName: string
  setNewProjectName: (name: string) => void
  newProjectPath: string
  setNewProjectPath: (path: string) => void
  newProjectPM: string
  setNewProjectPM: (pm: ProjectPM) => void
  newProjectTemplate: string | null
  setNewProjectTemplate: (t: string | null) => void
  newProjectUI: string | null
  setNewProjectUI: (u: string | null) => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && newProjectStatus !== "running") {
          onOpenChange(false)
          setNewProjectStep(0)
          setNewProjectStatus("idle")
          setNewProjectLog("")
        }
      }}
    >
      <DialogContent
        className={cn(
          "gap-0 overflow-hidden p-0",
          minimalChat ? "sm:max-w-lg" : "sm:max-w-2xl"
        )}
        style={{ fontSize: "16px" }}
      >
        <DialogTitle className="sr-only">New Project</DialogTitle>

        {/* Step indicator */}
        <div
          className={cn(
            "border-b border-border/30",
            minimalChat ? "px-4 pt-3 pb-2" : "px-6 pt-5 pb-3"
          )}
        >
          <div className="mb-2 flex items-center gap-3">
            {["Setup", "Framework", "UI Library", "Creating"].map(
              (label, i) => (
                <div key={label} className="flex items-center gap-2">
                  <div
                    className={cn(
                      "flex size-6 items-center justify-center rounded-full text-[10px] font-bold transition-colors",
                      i < newProjectStep
                        ? "bg-emerald-500/20 text-emerald-400"
                        : i === newProjectStep
                          ? "border border-primary/30 bg-primary/15 text-primary"
                          : "bg-muted/40 text-muted-foreground/40"
                    )}
                  >
                    {i < newProjectStep ? (
                      <CheckIcon className="size-3.5" />
                    ) : (
                      i + 1
                    )}
                  </div>
                  <span
                    className={cn(
                      "text-[11px] font-medium",
                      i === newProjectStep
                        ? "text-foreground"
                        : "text-muted-foreground/50"
                    )}
                  >
                    {label}
                  </span>
                  {i < 3 && (
                    <div
                      className={cn(
                        "h-px w-6",
                        i < newProjectStep
                          ? "bg-emerald-500/30"
                          : "bg-border/30"
                      )}
                    />
                  )}
                </div>
              )
            )}
          </div>
        </div>

        {/* Step 0: Name + Path + Package Manager */}
        {newProjectStep === 0 && (
          <>
            <div
              className={cn(
                minimalChat ? "space-y-3 px-4 py-3" : "space-y-5 px-6 py-5"
              )}
            >
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                  Project Name
                </label>
                <Input
                  placeholder="my-app"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  className="h-10 text-sm"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                  Location
                </label>
                <div className="flex gap-2">
                  <Input
                    placeholder="C:\Users\Projects"
                    value={newProjectPath}
                    onChange={(e) => setNewProjectPath(e.target.value)}
                    className="h-10 flex-1 font-mono text-sm text-xs"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-10 px-4"
                    onClick={async () => {
                      const f = await pickFolder()
                      if (f) setNewProjectPath(f)
                    }}
                  >
                    Browse
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                  Package Manager
                </label>
                <div className="grid grid-cols-4 gap-2">
                  {(
                    [
                      {
                        id: "npm",
                        name: "npm",
                        icon: assetUrl("icons/tech/npm.svg"),
                      },
                      {
                        id: "pnpm",
                        name: "pnpm",
                        icon: assetUrl("icons/tech/pnpm.svg"),
                      },
                      {
                        id: "bun",
                        name: "Bun",
                        icon: assetUrl("icons/tech/bun.svg"),
                      },
                      {
                        id: "yarn",
                        name: "Yarn",
                        icon: assetUrl("icons/tech/yarn.svg"),
                      },
                    ] as const
                  ).map((pm) => (
                    <button
                      key={pm.id}
                      type="button"
                      onClick={() => setNewProjectPM(pm.id)}
                      className={cn(
                        "flex items-center justify-center gap-2 rounded-lg border p-2.5 transition-all hover:bg-muted/30",
                        newProjectPM === pm.id
                          ? "border-primary/50 bg-primary/5"
                          : "border-border/30"
                      )}
                    >
                      <img src={pm.icon} alt={pm.name} className="size-5" />
                      <span className="text-xs font-medium">{pm.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-border/30 bg-muted/10 px-6 py-3">
              <p className="max-w-[350px] truncate font-mono text-[10px] text-muted-foreground">
                {newProjectPath && newProjectName
                  ? `${newProjectPath.replace(/\\/g, "/")}/${newProjectName}`
                  : ""}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={!newProjectName.trim() || !newProjectPath.trim()}
                  onClick={() => setNewProjectStep(1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </>
        )}

        {/* Step 1: Framework */}
        {newProjectStep === 1 && (
          <>
            <div className={cn(minimalChat ? "px-4 py-3" : "px-6 py-5")}>
              <label className="mb-2 block text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                Choose a Framework
              </label>
              <div className="grid grid-cols-4 gap-2">
                {(
                  [
                    {
                      id: "nextjs",
                      name: "Next.js",
                      desc: "React fullstack",
                      icon: assetUrl("icons/tech/nextjs.svg"),
                    },
                    {
                      id: "vite-react",
                      name: "Vite + React",
                      desc: "Fast React SPA",
                      icon: assetUrl("icons/tech/vite.svg"),
                    },
                    {
                      id: "vite-vue",
                      name: "Vite + Vue",
                      desc: "Vue 3 SPA",
                      icon: assetUrl("icons/tech/vue.svg"),
                    },
                    {
                      id: "nuxt",
                      name: "Nuxt",
                      desc: "Vue fullstack",
                      icon: assetUrl("icons/tech/nuxt.svg"),
                    },
                    {
                      id: "astro",
                      name: "Astro",
                      desc: "Content-driven",
                      icon: assetUrl("icons/tech/astro.svg"),
                    },
                    {
                      id: "svelte",
                      name: "SvelteKit",
                      desc: "Svelte fullstack",
                      icon: assetUrl("icons/tech/svelte.svg"),
                    },
                    {
                      id: "remix",
                      name: "Remix",
                      desc: "React framework",
                      icon: assetUrl("icons/tech/remix.svg"),
                    },
                    {
                      id: "express",
                      name: "Express",
                      desc: "Node.js API",
                      icon: assetUrl("icons/tech/express.svg"),
                    },
                    {
                      id: "tauri",
                      name: "Tauri",
                      desc: "Desktop app",
                      icon: assetUrl("icons/tech/tauri.svg"),
                    },
                    {
                      id: "electron",
                      name: "Electron",
                      desc: "Desktop app",
                      icon: assetUrl("icons/tech/electron.svg"),
                    },
                    {
                      id: "rust",
                      name: "Rust",
                      desc: "Cargo project",
                      icon: assetUrl("icons/tech/rust.svg"),
                    },
                    {
                      id: "empty",
                      name: "Empty",
                      desc: "Blank project",
                      icon: "",
                    },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() =>
                      setNewProjectTemplate(
                        newProjectTemplate === t.id ? null : t.id
                      )
                    }
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-all hover:bg-muted/30",
                      newProjectTemplate === t.id
                        ? "border-primary/50 bg-primary/5"
                        : "border-border/30"
                    )}
                  >
                    {t.icon ? (
                      <img src={t.icon} alt={t.name} className="size-6" />
                    ) : (
                      <FolderOpenIcon className="size-6 text-muted-foreground/50" />
                    )}
                    <span className="text-xs font-medium">{t.name}</span>
                    <span className="text-[10px] text-muted-foreground/60">
                      {t.desc}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex justify-between border-t border-border/30 bg-muted/10 px-6 py-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setNewProjectStep(0)}
              >
                Back
              </Button>
              <Button
                size="sm"
                disabled={!newProjectTemplate}
                onClick={() => setNewProjectStep(2)}
              >
                Next
              </Button>
            </div>
          </>
        )}

        {/* Step 2: UI Library */}
        {newProjectStep === 2 && (
          <>
            <div className={cn(minimalChat ? "px-4 py-3" : "px-6 py-5")}>
              <label className="mb-2 block text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                UI Library{" "}
                <span className="text-muted-foreground/40 normal-case">
                  (optional)
                </span>
              </label>
              <div className="grid grid-cols-4 gap-2">
                {(
                  [
                    {
                      id: "shadcn",
                      name: "shadcn/ui",
                      desc: "Radix + Tailwind",
                      icon: assetUrl("icons/tech/shadcn.svg"),
                    },
                    {
                      id: "tailwind",
                      name: "Tailwind CSS",
                      desc: "Utility-first CSS",
                      icon: assetUrl("icons/tech/tailwindcss.svg"),
                    },
                    {
                      id: "mantine",
                      name: "Mantine",
                      desc: "React components",
                      icon: assetUrl("icons/tech/mantine.svg"),
                    },
                    {
                      id: "chakra",
                      name: "Chakra UI",
                      desc: "React components",
                      icon: assetUrl("icons/tech/chakraui.svg"),
                    },
                    {
                      id: "mui",
                      name: "Material UI",
                      desc: "Google Material",
                      icon: assetUrl("icons/tech/mui.svg"),
                    },
                    {
                      id: "antd",
                      name: "Ant Design",
                      desc: "Enterprise UI",
                      icon: assetUrl("icons/tech/antdesign.svg"),
                    },
                    {
                      id: "radix",
                      name: "Radix UI",
                      desc: "Unstyled primitives",
                      icon: assetUrl("icons/tech/radixui.svg"),
                    },
                    {
                      id: "none",
                      name: "None",
                      desc: "Skip this step",
                      icon: "",
                    },
                  ] as const
                ).map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() =>
                      setNewProjectUI(newProjectUI === u.id ? null : u.id)
                    }
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-lg border p-3 text-center transition-all hover:bg-muted/30",
                      newProjectUI === u.id
                        ? "border-primary/50 bg-primary/5"
                        : "border-border/30"
                    )}
                  >
                    {u.icon ? (
                      <img src={u.icon} alt={u.name} className="size-5" />
                    ) : (
                      <XIcon className="size-5 text-muted-foreground/30" />
                    )}
                    <span className="text-[11px] font-medium">{u.name}</span>
                    <span className="text-[9px] text-muted-foreground/60">
                      {u.desc}
                    </span>
                  </button>
                ))}
              </div>

              {/* Summary */}
              <div className="mt-4 space-y-1 rounded-lg border border-border/20 bg-muted/10 px-4 py-3">
                <p className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                  Summary
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <span>
                    <span className="text-muted-foreground">Name:</span>{" "}
                    {newProjectName}
                  </span>
                  <span>
                    <span className="text-muted-foreground">PM:</span>{" "}
                    {newProjectPM}
                  </span>
                  <span>
                    <span className="text-muted-foreground">Framework:</span>{" "}
                    {newProjectTemplate}
                  </span>
                  {newProjectUI && newProjectUI !== "none" && (
                    <span>
                      <span className="text-muted-foreground">UI:</span>{" "}
                      {newProjectUI}
                    </span>
                  )}
                </div>
                <p className="truncate font-mono text-[10px] text-muted-foreground">
                  {newProjectPath.replace(/\\/g, "/")}/{newProjectName}
                </p>
              </div>
            </div>
            <div className="flex justify-between border-t border-border/30 bg-muted/10 px-6 py-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setNewProjectStep(1)}
              >
                Back
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  const pm = newProjectPM
                  const install =
                    pm === "bun"
                      ? "bun install"
                      : pm === "pnpm"
                        ? "pnpm install"
                        : pm === "yarn"
                          ? "yarn"
                          : "npm install"
                  const pmFlag =
                    pm === "bun"
                      ? "--bun"
                      : pm === "pnpm"
                        ? "--use-pnpm"
                        : pm === "yarn"
                          ? "--use-yarn"
                          : "--use-npm"
                  const npx =
                    pm === "bun" ? "bunx" : pm === "pnpm" ? "pnpx" : "npx"

                  const templateCmds: Record<string, string> = {
                    nextjs: `${npx} create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias "@/*" ${pmFlag} --yes`,
                    "vite-react": `${pm} create vite@latest . -- --template react-ts`,
                    "vite-vue": `${pm} create vite@latest . -- --template vue-ts`,
                    nuxt: `${npx} nuxi@latest init . --force --package-manager ${pm}`,
                    astro: `${pm} create astro@latest . -- --template basics --yes --no-git`,
                    svelte: `${npx} sv create . --template minimal --types ts`,
                    remix: `${npx} create-remix@latest . --yes`,
                    express: `${npx} express-generator --no-view .`,
                    tauri: `${pm} create tauri-app@latest . -- --template react-ts --manager ${pm}`,
                    electron: `${npx} create-electron-vite@latest . -- --template react-ts`,
                    rust: "cargo init .",
                    empty: "",
                  }
                  const uiCmds: Record<string, string> = {
                    shadcn: `${npx} shadcn@latest init -y && ${npx} shadcn@latest add button input label card dialog`,
                    tailwind: `${install.split(" ")[0]} ${pm === "bun" ? "add -d" : pm === "pnpm" ? "add -D" : pm === "yarn" ? "add -D" : "install -D"} tailwindcss @tailwindcss/vite`,
                    mantine: `${install.split(" ")[0]} ${pm === "bun" ? "add" : pm === "pnpm" ? "add" : pm === "yarn" ? "add" : "install"} @mantine/core @mantine/hooks`,
                    chakra: `${install.split(" ")[0]} ${pm === "bun" ? "add" : pm === "pnpm" ? "add" : pm === "yarn" ? "add" : "install"} @chakra-ui/react @emotion/react @emotion/styled framer-motion`,
                    mui: `${install.split(" ")[0]} ${pm === "bun" ? "add" : pm === "pnpm" ? "add" : pm === "yarn" ? "add" : "install"} @mui/material @emotion/react @emotion/styled`,
                    antd: `${install.split(" ")[0]} ${pm === "bun" ? "add" : pm === "pnpm" ? "add" : pm === "yarn" ? "add" : "install"} antd`,
                    radix: `${install.split(" ")[0]} ${pm === "bun" ? "add" : pm === "pnpm" ? "add" : pm === "yarn" ? "add" : "install"} @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-popover`,
                  }

                  const isWin = navigator.platform.includes("Win")
                  const basePath = isWin
                    ? newProjectPath.replace(/\//g, "\\")
                    : newProjectPath
                  const projName = newProjectName.trim()
                  const fullPath = isWin
                    ? `${basePath}\\${projName}`
                    : `${basePath}/${projName}`
                  const scaffoldCmd =
                    templateCmds[newProjectTemplate || ""] || ""
                  const uiCmd =
                    newProjectUI && newProjectUI !== "none"
                      ? uiCmds[newProjectUI] || ""
                      : ""

                  setNewProjectStep(3)
                  setNewProjectStatus("running")
                  setNewProjectLog("")
                  const log = (msg: string) =>
                    setNewProjectLog((prev) => prev + msg + "\n")

                  const run = async (
                    label: string,
                    cmd: string,
                    cwd: string
                  ) => {
                    log(`[${label}]`)
                    log(`$ ${cmd}`)
                    try {
                      const out = await runShellCommand(cmd, cwd)
                      if (out?.trim()) log(out.trim())
                      log("")
                      return out
                    } catch (err) {
                      log(`Error: ${err}\n`)
                      throw err
                    }
                  }

                  try {
                    // 1. Create directory — use just the folder name with cwd in parent
                    const mkdirCmd = isWin
                      ? `mkdir ${projName}`
                      : `mkdir -p "${projName}"`
                    await run("Creating directory", mkdirCmd, basePath)

                    // 2. Scaffold framework
                    if (scaffoldCmd) {
                      await run(
                        `Scaffolding ${newProjectTemplate}`,
                        scaffoldCmd,
                        fullPath
                      )
                    }

                    // 3. Install deps (if scaffold didn't)
                    if (
                      scaffoldCmd &&
                      !["nextjs", "astro", "nuxt", "remix"].includes(
                        newProjectTemplate || ""
                      )
                    ) {
                      await run("Installing dependencies", install, fullPath)
                    }

                    // 4. UI library
                    if (uiCmd) {
                      await run(`Installing ${newProjectUI}`, uiCmd, fullPath)
                    }

                    // 5. Git init
                    await run("Initializing git", "git init", fullPath)

                    log("Project created successfully!")
                    setNewProjectStatus("done")
                    useChatStore
                      .getState()
                      .createThread(projName, projName, fullPath)
                  } catch (err) {
                    log(`\nFailed: ${err}`)
                    setNewProjectStatus("error")
                  }
                }}
              >
                Create Project
              </Button>
            </div>
          </>
        )}

        {/* Step 3: Progress */}
        {newProjectStep === 3 && (
          <div
            className={cn("space-y-3", minimalChat ? "px-4 py-3" : "px-6 py-5")}
          >
            <div className="flex items-center gap-2">
              {newProjectStatus === "running" && (
                <Loader2Icon className="size-4 animate-spin text-primary" />
              )}
              {newProjectStatus === "done" && (
                <CheckIcon className="size-4 text-emerald-500" />
              )}
              {newProjectStatus === "error" && (
                <XIcon className="size-4 text-red-500" />
              )}
              <span className="text-sm font-medium">
                {newProjectStatus === "running"
                  ? "Creating project..."
                  : newProjectStatus === "done"
                    ? "Project created!"
                    : "Something went wrong"}
              </span>
            </div>
            <div className="max-h-[350px] overflow-y-auto rounded-lg border border-border/20 bg-[oklch(0.13_0_0)]">
              <pre className="px-3 py-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-foreground/60">
                {newProjectLog || "Starting..."}
              </pre>
            </div>
            {newProjectStatus !== "running" && (
              <div className="flex justify-end gap-2 pt-1">
                {newProjectStatus === "error" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setNewProjectStep(2)
                      setNewProjectStatus("idle")
                      setNewProjectLog("")
                    }}
                  >
                    Back
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => {
                    onOpenChange(false)
                    setNewProjectStep(0)
                    setNewProjectStatus("idle")
                    setNewProjectLog("")
                  }}
                >
                  {newProjectStatus === "done" ? "Open Project" : "Close"}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
