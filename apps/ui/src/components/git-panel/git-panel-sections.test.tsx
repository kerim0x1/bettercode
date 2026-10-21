import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { BranchesSection } from "./branches-section"
import { ChangesSection } from "./changes-section"
import { HistorySection } from "./history-section"
import { RemoteSyncSection } from "./remote-sync-section"

const noop = () => {}

function renderChanges(
  overrides: Partial<Parameters<typeof ChangesSection>[0]> = {}
) {
  return renderToStaticMarkup(
    <ChangesSection
      staged={["src/staged.ts"]}
      modified={["src/modified.ts"]}
      untracked={[]}
      stagedTotal={1}
      totalChanges={2}
      visibleCount={2}
      diffStats={{ "src/modified.ts": { additions: 3, deletions: 1 } }}
      editorMode={false}
      showFilterEmptyState={false}
      stagedOpen
      onStagedOpenChange={noop}
      changesOpen
      onChangesOpenChange={noop}
      untrackedOpen
      onUntrackedOpenChange={noop}
      onOpenFile={noop}
      onStageAll={noop}
      onUnstageAll={noop}
      onStashPop={noop}
      onStageFile={noop}
      onUnstageFile={noop}
      onDiscard={noop}
      {...overrides}
    />
  )
}

describe("git panel sections", () => {
  it("lists the visible file groups with their bulk actions and stats", () => {
    const html = renderChanges()
    expect(html).toContain("Staged Changes")
    expect(html).toContain(">Changes<")
    expect(html).not.toContain("Untracked")
    expect(html).toContain("Stage All")
    expect(html).toContain("Unstage All")
    expect(html).toContain("Pop Stash")
    expect(html).toContain("modified.ts")
    expect(html).toContain("+3")
    expect(html).toContain("−1")
  })

  it("says when the filter hides every file and when the tree is clean", () => {
    const filtered = renderChanges({
      staged: [],
      modified: [],
      visibleCount: 0,
      showFilterEmptyState: true,
    })
    expect(filtered).toContain("No changed files match this filter.")

    const clean = renderChanges({
      staged: [],
      modified: [],
      stagedTotal: 0,
      totalChanges: 0,
      visibleCount: 0,
    })
    expect(clean).toContain("No changes — working tree is clean.")
    expect(clean).not.toContain("Stage All")
  })

  it("offers Publish for a branch without an upstream", () => {
    const html = renderToStaticMarkup(
      <RemoteSyncSection
        status={{
          branch: "feature",
          is_clean: true,
          staged: [],
          modified: [],
          untracked: [],
          ahead: 0,
          behind: 0,
          upstream: null,
        }}
        isPushing={false}
        isPulling={false}
        isCommitting={false}
        isFetching={false}
        lastFetchedAt={null}
        onFetch={noop}
        onPush={noop}
        onPull={noop}
      />
    )
    expect(html).toContain("Branch not published")
    expect(html).toContain("Publish")
    expect(html).toContain("Fetch to check for incoming commits")
  })

  it("marks the current branch and lists commits", () => {
    const branches = renderToStaticMarkup(
      <BranchesSection
        branches={["main", "feature"]}
        currentBranch="main"
        newBranchName=""
        onNewBranchNameChange={noop}
        onCreateBranch={noop}
        onCheckout={noop}
      />
    )
    expect(branches).toContain("main")
    expect(branches).toContain("feature")
    expect(branches).toContain('aria-label="New branch name"')

    const history = renderToStaticMarkup(
      <HistorySection
        logEntries={[
          {
            hash: "0123456789abcdef",
            message: "Fix it",
            author: "Ada",
            date: "",
          },
        ]}
      />
    )
    expect(history).toContain("Fix it")
    expect(history).toContain("0123456")
    expect(history).not.toContain("0123456789")
    expect(renderToStaticMarkup(<HistorySection logEntries={[]} />)).toContain(
      "No commits"
    )
  })
})
