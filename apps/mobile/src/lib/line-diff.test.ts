import { parseGitDiff } from "@betterc0de/schema/git-diff"
import { describe, expect, it } from "vitest"
import { unifiedFileDiff } from "./line-diff"

describe("unified diffs", () => {
  it("are what git prints: headers, three lines of context, a replaced line removed first", () => {
    const before = ["one", "two", "three", "four", "five"].join("\n") + "\n"
    const after = ["one", "two", "THREE", "four", "five"].join("\n") + "\n"
    expect(unifiedFileDiff("a.txt", before, after)).toBe(
      [
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,5 +1,5 @@",
        " one",
        " two",
        "-three",
        "+THREE",
        " four",
        " five",
        "",
      ].join("\n")
    )
    expect(unifiedFileDiff("a.txt", before, before)).toBe("")
  })

  it("marks new and deleted files as git does", () => {
    expect(unifiedFileDiff("new.txt", undefined, "a\nb\n")).toBe(
      "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n"
    )
    expect(unifiedFileDiff("old.txt", "a\n", undefined)).toBe(
      "diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n"
    )
  })

  it("keeps changes six lines apart in one hunk and splits them at seven", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    const edit = (changed: number[]) =>
      lines
        .map((line, index) => (changed.includes(index + 1) ? `${line}!` : line))
        .join("\n") + "\n"
    const original = lines.join("\n") + "\n"
    const hunks = (changed: number[]) =>
      parseGitDiff(unifiedFileDiff("f.txt", original, edit(changed)))[0]!.hunks
        .length
    expect(hunks([3, 10])).toBe(1)
    expect(hunks([3, 11])).toBe(2)
  })
})
