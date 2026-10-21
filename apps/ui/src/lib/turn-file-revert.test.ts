import { describe, expect, it } from "vitest"
import { preTurnFileState } from "./turn-file-revert"

const lines = (...values: string[]) =>
  values.map((value) => `${value}\n`).join("")

const BEFORE = lines(
  "line1",
  "line2",
  "line3",
  "line4",
  "line5",
  "line6",
  "line7",
  "line8",
  "line9",
  "line10"
)
const AFTER = lines(
  "line1",
  "LINE2",
  "line3",
  "line4",
  "line5",
  "line6",
  "line7",
  "line8",
  "new",
  "line9",
  "line10"
)

const TURN_DIFF = [
  "diff --git a/README.md b/README.md",
  "index 0000001..0000002 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1 @@",
  "-old title",
  "+new title",
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,5 +1,5 @@",
  " line1",
  "-line2",
  "+LINE2",
  " line3",
  " line4",
  " line5",
  "@@ -6,5 +6,6 @@ function context()",
  " line6",
  " line7",
  " line8",
  "+new",
  " line9",
  " line10",
  "diff --git a/notes.md b/notes.md",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/notes.md",
  "@@ -0,0 +1,2 @@",
  "+# Notes",
  "+hello",
  "diff --git a/old.txt b/old.txt",
  "deleted file mode 100644",
  "index 4444444..0000000",
  "--- a/old.txt",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-keep",
  "-me",
  "diff --git a/img.png b/img.png",
  "index 5555555..6666666 100644",
  "Binary files a/img.png and b/img.png differ",
  "",
].join("\n")

describe("reversing a turn's diff for one file", () => {
  it("restores an edited file from its own section of a multi-file diff", () => {
    expect(preTurnFileState(TURN_DIFF, "src/app.ts", AFTER)).toEqual({
      kind: "content",
      content: BEFORE,
    })
    expect(preTurnFileState(TURN_DIFF, "README.md", "new title\n")).toEqual({
      kind: "content",
      content: "old title\n",
    })
  })

  it("keeps later edits outside the turn's hunks", () => {
    const edited = AFTER.replace("line4\n", "line4 (mine)\n")
    // line4 is context in the first hunk, so this edit conflicts.
    expect(preTurnFileState(TURN_DIFF, "src/app.ts", edited)).toBeNull()
    const appended = `${AFTER}line11\n`
    expect(preTurnFileState(TURN_DIFF, "src/app.ts", appended)).toEqual({
      kind: "content",
      content: `${BEFORE}line11\n`,
    })
  })

  it("refuses when the file no longer matches what the turn wrote", () => {
    expect(
      preTurnFileState(TURN_DIFF, "src/app.ts", AFTER.replace("LINE2", "x"))
    ).toBeNull()
    expect(preTurnFileState(TURN_DIFF, "src/app.ts", null)).toBeNull()
  })

  it("reports a file the turn created as absent", () => {
    expect(preTurnFileState(TURN_DIFF, "notes.md", "# Notes\nhello\n")).toEqual(
      { kind: "absent" }
    )
    expect(
      preTurnFileState(TURN_DIFF, "notes.md", "# Notes\nhello\nmore\n")
    ).toBeNull()
  })

  it("recreates a file the turn deleted", () => {
    expect(preTurnFileState(TURN_DIFF, "old.txt", null)).toEqual({
      kind: "content",
      content: "keep\nme\n",
    })
    expect(preTurnFileState(TURN_DIFF, "old.txt", "recreated\n")).toBeNull()
  })

  it("gives up on binary files and files missing from the diff", () => {
    expect(preTurnFileState(TURN_DIFF, "img.png", "PNG")).toBeNull()
    expect(preTurnFileState(TURN_DIFF, "src/other.ts", "x\n")).toBeNull()
  })

  it("restores a missing final newline", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "\\ No newline at end of file",
      "+c",
      "",
    ].join("\n")
    expect(preTurnFileState(diff, "f.txt", "a\nc\n")).toEqual({
      kind: "content",
      content: "a\nb",
    })
  })

  it("keeps CRLF line endings", () => {
    const diff = [
      "diff --git a/win.txt b/win.txt",
      "--- a/win.txt",
      "+++ b/win.txt",
      "@@ -1,2 +1,2 @@",
      " x\r",
      "-y\r",
      "+z\r",
      "",
    ].join("\n")
    expect(preTurnFileState(diff, "win.txt", "x\r\nz\r\n")).toEqual({
      kind: "content",
      content: "x\r\ny\r\n",
    })
  })

  it("matches repository-root paths for a project in a subfolder", () => {
    const diff = TURN_DIFF.replaceAll("src/app.ts", "packages/web/src/app.ts")
    expect(preTurnFileState(diff, "src/app.ts", AFTER)).toEqual({
      kind: "content",
      content: BEFORE,
    })
  })

  it("rejects a diff cut off inside the file's hunk", () => {
    const cut = TURN_DIFF.slice(0, TURN_DIFF.indexOf(" line9"))
    expect(preTurnFileState(cut, "src/app.ts", AFTER)).toBeNull()
  })
})
