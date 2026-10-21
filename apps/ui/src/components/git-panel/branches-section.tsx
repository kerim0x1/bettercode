import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { CheckIcon, GitBranchIcon, PlusIcon } from "lucide-react"

/** The "branches" tab: create a branch, or switch to a listed one. */
export function BranchesSection({
  branches,
  currentBranch,
  newBranchName,
  onNewBranchNameChange,
  onCreateBranch,
  onCheckout,
}: {
  branches: string[]
  currentBranch: string
  newBranchName: string
  onNewBranchNameChange: (name: string) => void
  onCreateBranch: () => void
  onCheckout: (branch: string) => void
}) {
  return (
    <div>
      {/* New branch input */}
      <div className="git-new-branch flex items-center gap-1 border-b border-border/20 px-2 py-1.5">
        <input
          aria-label="New branch name"
          value={newBranchName}
          onChange={(e) => onNewBranchNameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCreateBranch()
          }}
          placeholder="New branch name..."
          className="flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/40"
        />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 rounded-md px-2 text-[10px]"
          disabled={!newBranchName.trim()}
          onClick={onCreateBranch}
        >
          <PlusIcon className="size-3" /> Create
        </Button>
      </div>
      {/* Branch list */}
      {branches.map((branch) => (
        <button
          key={branch}
          type="button"
          onClick={() => onCheckout(branch)}
          className={cn(
            "git-branch-row flex w-full items-center gap-2 px-3 py-1 text-[11px] transition-colors hover:bg-accent/50",
            branch === currentBranch && "font-medium text-foreground"
          )}
        >
          <GitBranchIcon className="size-3 shrink-0" />
          <span className="flex-1 truncate text-left">{branch}</span>
          {branch === currentBranch && (
            <CheckIcon className="size-3 shrink-0" />
          )}
        </button>
      ))}
      {branches.length === 0 && (
        <p className="px-3 py-3 text-center text-[10px] text-muted-foreground/50">
          No branches found
        </p>
      )}
    </div>
  )
}
