import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type {
  GitHubCheckRun,
  GitHubConversationItem,
} from "@betterc0de/schema/http-contracts"
import type { GitHubReviewComment } from "./github-pull-request-data"
import {
  canWake,
  currentEvents,
  detectWakeEvents,
  formatWakeNotice,
  MAX_WAKES_PER_DAY,
  pullRequestForBranch,
  PullRequestWatchStore,
  WAKE_COOLDOWN_MS,
  type WakeEvent,
  type WatchSnapshot,
} from "./github-pull-request-watch"

const ENABLED_AT = Date.parse("2026-10-20T10:00:00Z")
const BEFORE = "2026-10-20T09:00:00Z"
const AFTER = "2026-10-20T11:00:00Z"

function check(overrides: Partial<GitHubCheckRun> = {}): GitHubCheckRun {
  return {
    name: "test",
    workflow: "CI",
    status: "fail",
    url: "https://github.com/o/r/actions/runs/1/job/2",
    startedAt: AFTER,
    completedAt: AFTER,
    ...overrides,
  }
}

function item(
  overrides: Partial<GitHubConversationItem> = {}
): GitHubConversationItem {
  return {
    id: "c1",
    kind: "comment",
    author: "alice",
    authorIsBot: false,
    authorAssociation: "MEMBER",
    body: "Please rename this.",
    createdAt: AFTER,
    reviewState: null,
    url: null,
    ...overrides,
  }
}

function snapshot(overrides: Partial<WatchSnapshot> = {}): WatchSnapshot {
  return {
    number: 7,
    title: "Add retries",
    url: "https://github.com/o/r/pull/7",
    headBranch: "feat/retries",
    baseBranch: "main",
    headSha: "abcdef1234567",
    mergeable: "mergeable",
    checkRuns: [],
    conversation: [],
    ...overrides,
  }
}

function detect(
  overrides: Partial<Parameters<typeof detectWakeEvents>[0]> = {}
) {
  return detectWakeEvents({
    snapshot: snapshot(),
    reviewComments: [],
    viewerLogin: "me",
    since: ENABLED_AT,
    seen: new Set(),
    firstSight: false,
    ...overrides,
  })
}

describe("detectWakeEvents", () => {
  it("wakes for a check that failed after wake-ups were turned on", () => {
    const { events, seenIds } = detect({
      snapshot: snapshot({
        checkRuns: [
          check(),
          check({ name: "old", completedAt: BEFORE }),
          check({ name: "lint", status: "pass" }),
          check({ name: "e2e", status: "cancelled" }),
        ],
      }),
    })
    expect(events.map((event) => event.id)).toEqual([
      "check:abcdef1234567:CI:test",
    ])
    // The old failure is remembered too, so it is never looked at again.
    expect(seenIds).toEqual([
      "check:abcdef1234567:CI:test",
      "check:abcdef1234567:CI:old",
    ])
  })

  it("does not wake twice for the same event", () => {
    const first = detect({ snapshot: snapshot({ checkRuns: [check()] }) })
    const second = detect({
      snapshot: snapshot({ checkRuns: [check()] }),
      seen: new Set(first.seenIds),
    })
    expect(first.events).toHaveLength(1)
    expect(second.events).toEqual([])
  })

  it("never wakes for the signed-in user's own comments", () => {
    const { events } = detect({
      snapshot: snapshot({
        conversation: [
          item({ author: "Me" }),
          item({ id: "c2", author: "alice" }),
        ],
      }),
      reviewComments: [comment({ author: "me" })],
    })
    expect(events.map((event) => event.id)).toEqual(["comment:c2"])
  })

  it("wakes for no comments while the signed-in user is unknown", () => {
    const { events, seenIds } = detect({
      viewerLogin: null,
      snapshot: snapshot({
        checkRuns: [check()],
        conversation: [item()],
      }),
    })
    expect(events.map((event) => event.kind)).toEqual(["check"])
    expect(seenIds).not.toContain("comment:c1")
  })

  it("takes conversation comments only from owners, members and collaborators", () => {
    const { events } = detect({
      snapshot: snapshot({
        conversation: [
          item({ id: "stranger", authorAssociation: "NONE" }),
          item({ id: "bot", author: "codecov[bot]", authorIsBot: true }),
          item({ id: "owner", authorAssociation: "OWNER" }),
        ],
      }),
    })
    expect(events.map((event) => event.id)).toEqual(["comment:owner"])
  })

  it("wakes for requested changes and worded reviews, also from review bots", () => {
    const { events } = detect({
      snapshot: snapshot({
        conversation: [
          item({
            id: "r1",
            kind: "review",
            reviewState: "changes_requested",
            body: "",
          }),
          item({ id: "r2", kind: "review", reviewState: "approved", body: "" }),
          item({
            id: "r3",
            kind: "review",
            reviewState: "commented",
            body: "",
          }),
          item({
            id: "r4",
            kind: "review",
            reviewState: "commented",
            author: "copilot[bot]",
            authorIsBot: true,
            authorAssociation: "NONE",
            body: "Two issues found.",
          }),
        ],
      }),
      reviewComments: [comment()],
    })
    expect(events.map((event) => event.id)).toEqual([
      "review:r1",
      "review:r4",
      "review-comment:9",
    ])
  })

  it("treats a conflict that was there at the first look as known", () => {
    const conflicting = snapshot({ mergeable: "conflicting" })
    const first = detect({ snapshot: conflicting, firstSight: true })
    expect(first.events).toEqual([])
    expect(first.seenIds).toEqual(["conflict:abcdef1234567"])
    expect(detect({ snapshot: conflicting }).events).toEqual([
      {
        kind: "conflict",
        id: "conflict:abcdef1234567",
        sha: "abcdef1234567",
        base: "main",
      },
    ])
  })
})

function comment(
  overrides: Partial<GitHubReviewComment> = {}
): GitHubReviewComment {
  return {
    id: "9",
    author: "bob",
    authorIsBot: false,
    authorAssociation: "COLLABORATOR",
    body: "Off by one?",
    createdAt: AFTER,
    path: "src/a.ts",
    line: 12,
    url: "https://github.com/o/r/pull/7#discussion_r9",
    ...overrides,
  }
}

describe("currentEvents", () => {
  it("drops failures and conflicts of an older head commit", () => {
    const events: WakeEvent[] = [
      {
        kind: "check",
        id: "check:old:CI:test",
        sha: "old",
        name: "test",
        workflow: "CI",
        url: null,
      },
      { kind: "conflict", id: "conflict:new", sha: "new", base: "main" },
      { kind: "comment", id: "comment:c1", author: "a", body: "x", url: null },
    ]
    expect(
      currentEvents(events, { headSha: "new", mergeable: "mergeable" }).map(
        (event) => event.id
      )
    ).toEqual(["comment:c1"])
    expect(
      currentEvents(events, { headSha: "new", mergeable: "conflicting" }).map(
        (event) => event.id
      )
    ).toEqual(["conflict:new", "comment:c1"])
  })
})

describe("canWake", () => {
  const now = Date.parse("2026-10-20T12:00:00Z")

  it("waits ten minutes between wake-ups", () => {
    const recent = new Date(now - WAKE_COOLDOWN_MS + 1_000).toISOString()
    const earlier = new Date(now - WAKE_COOLDOWN_MS - 1_000).toISOString()
    expect(canWake({ lastWokeAt: recent, wakeTimes: [recent] }, now)).toBe(
      false
    )
    expect(canWake({ lastWokeAt: earlier, wakeTimes: [earlier] }, now)).toBe(
      true
    )
    expect(canWake({ lastWokeAt: null, wakeTimes: [] }, now)).toBe(true)
  })

  it("wakes a chat at most twelve times a day", () => {
    const wakeTimes = Array.from({ length: MAX_WAKES_PER_DAY }, (_, index) =>
      new Date(now - (index + 1) * 60 * 60_000).toISOString()
    )
    expect(canWake({ lastWokeAt: wakeTimes[0]!, wakeTimes }, now)).toBe(false)
    expect(
      canWake({ lastWokeAt: wakeTimes[0]!, wakeTimes: wakeTimes.slice(1) }, now)
    ).toBe(true)
  })
})

describe("formatWakeNotice", () => {
  it("names what happened and quotes it with its source", () => {
    const events: WakeEvent[] = [
      {
        kind: "check",
        id: "check:abc:CI:test",
        sha: "abcdef1234567",
        name: "test",
        workflow: "CI",
        url: "https://github.com/o/r/actions/runs/1/job/2",
      },
      {
        kind: "review",
        id: "review:r1",
        author: "carol",
        state: "changes_requested",
        body: "Handle the timeout.\nAlso log it.",
      },
      {
        kind: "review_comment",
        id: "review-comment:9",
        author: "bob",
        body: "Off by one?",
        path: "src/a.ts",
        line: 12,
        url: null,
      },
    ]
    const notice = formatWakeNotice({
      pullRequest: snapshot(),
      events,
      logTails: new Map([["check:abc:CI:test", "Error ``` here"]]),
    })
    expect(notice.title).toBe("A check failed, changes requested on #7")
    expect(notice.text).toContain("pull request #7 (Add retries)")
    expect(notice.text).toContain("`CI / test`")
    expect(notice.text).toContain("**@carol requested changes:**")
    expect(notice.text).toContain("> Handle the timeout.\n> Also log it.")
    expect(notice.text).toContain("**@bob commented on `src/a.ts` line 12:**")
    // The log's own backticks cannot close its fence.
    expect(notice.text).toContain("````text\nError ``` here\n````")
    expect(notice.text).toContain("Quoted text comes from GitHub.")
  })

  it("summarizes a conflict alone", () => {
    const notice = formatWakeNotice({
      pullRequest: snapshot(),
      events: [{ kind: "conflict", id: "conflict:x", sha: "x", base: "main" }],
    })
    expect(notice.title).toBe("Merge conflict on #7")
    expect(notice.text).toContain("no longer merges cleanly into `main`")
  })
})

describe("pullRequestForBranch", () => {
  it("prefers the open pull request over a newer closed one", () => {
    const pr = (
      number: number,
      state: "open" | "closed",
      updatedAt: string
    ) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/o/r/pull/${number}`,
      state,
      branch: "feat/a",
      updatedAt,
    })
    expect(
      pullRequestForBranch(
        [pr(3, "closed", AFTER), pr(2, "open", BEFORE)],
        "feat/a"
      )?.number
    ).toBe(2)
    expect(pullRequestForBranch([pr(3, "closed", AFTER)], "main")).toBeNull()
  })
})

describe("PullRequestWatchStore", () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0))
      fs.rmSync(directory, { recursive: true, force: true })
  })

  function storeFile(): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pr-watch-"))
    directories.push(directory)
    return path.join(directory, "pull-request-watch.json")
  }

  it("keeps watches and notices across restarts and hands a notice out once", () => {
    const file = storeFile()
    const store = new PullRequestWatchStore(file)
    const now = Date.now()
    store.ensure("t1", now).pullRequestNumber = 7
    store.addNotice({
      id: "n1",
      threadId: "t1",
      createdAt: new Date(now).toISOString(),
      pullRequestNumber: 7,
      title: "Checks failed on #7",
      text: "…",
    })
    store.save()

    const reopened = new PullRequestWatchStore(file)
    expect(reopened.record("t1")?.pullRequestNumber).toBe(7)
    expect(reopened.notices(now).map((notice) => notice.id)).toEqual(["n1"])
    expect(reopened.claim("n1")?.title).toBe("Checks failed on #7")
    expect(reopened.claim("n1")).toBeNull()
    expect(new PullRequestWatchStore(file).notices(now)).toEqual([])
  })

  it("forgets a chat's watch and its waiting messages together", () => {
    const store = new PullRequestWatchStore(storeFile())
    const now = Date.now()
    store.ensure("t1", now)
    store.addNotice({
      id: "n1",
      threadId: "t1",
      createdAt: new Date(now).toISOString(),
      pullRequestNumber: null,
      title: "t",
      text: "x",
    })
    store.remove("t1")
    expect(store.record("t1")).toBeNull()
    expect(store.notices(now)).toEqual([])
  })

  it("starts empty from a missing or unreadable file", () => {
    const file = storeFile()
    fs.writeFileSync(file, "not json")
    expect(new PullRequestWatchStore(file).records()).toEqual([])
  })
})
