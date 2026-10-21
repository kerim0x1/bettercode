import { describe, expect, it } from "vitest"
import {
  addChatFolder,
  chatFolderName,
  chatPlacements,
  folderOfThread,
  moveChatFolder,
  newChatFolderId,
  placeChatInFolder,
  placeChatsInFolder,
  removeChatFolder,
  removeChatsFromFolders,
  renameChatFolder,
  restoreChatFolder,
  restoreChatPlacements,
  shiftChatFolder,
  type ChatFolder,
} from "./chat-folders"

function folders(): ChatFolder[] {
  return [
    { id: "a", name: "Client", thread_ids: ["t1", "t2", "t3"] },
    { id: "b", name: "Experiments", thread_ids: ["t4"] },
    { id: "c", name: "Later", thread_ids: [] },
  ]
}

const order = (list: ChatFolder[]) => list.map((folder) => folder.id)

describe("chat folders", () => {
  it("cleans up names and gives up on blank ones", () => {
    expect(chatFolderName("  Client   work ")).toBe("Client work")
    expect(chatFolderName("   ")).toBeNull()
    expect(chatFolderName("x".repeat(200))).toHaveLength(80)
    expect(newChatFolderId()).toMatch(/^folder-/)
    expect(newChatFolderId()).not.toBe(newChatFolderId())
  })

  it("adds a folder at the end and can take a chat along", () => {
    const next = addChatFolder(folders(), { id: "d", name: "New" }, "t2")
    expect(order(next)).toEqual(["a", "b", "c", "d"])
    expect(next[3]).toEqual({ id: "d", name: "New", thread_ids: ["t2"] })
    // A chat lives in one folder only.
    expect(next[0]!.thread_ids).toEqual(["t1", "t3"])
    expect(folderOfThread(next, "t2")?.id).toBe("d")
  })

  it("renames and removes, and returns the same list when nothing changes", () => {
    const list = folders()
    expect(renameChatFolder(list, "a", "Client")).toBe(list)
    expect(renameChatFolder(list, "a", "Work")[0]!.name).toBe("Work")
    expect(removeChatFolder(list, "missing")).toBe(list)
    const removed = removeChatFolder(list, "a")
    expect(order(removed)).toEqual(["b", "c"])
    expect(folderOfThread(removed, "t1")).toBeUndefined()
  })

  it("reorders folders by drop position and by one step", () => {
    const list = folders()
    expect(order(moveChatFolder(list, "c", "a"))).toEqual(["c", "a", "b"])
    expect(order(moveChatFolder(list, "a", null))).toEqual(["b", "c", "a"])
    expect(moveChatFolder(list, "a", "b")).toBe(list)
    expect(moveChatFolder(list, "a", "a")).toBe(list)
    expect(order(shiftChatFolder(list, "b", -1))).toEqual(["b", "a", "c"])
    expect(order(shiftChatFolder(list, "b", 1))).toEqual(["a", "c", "b"])
    expect(shiftChatFolder(list, "a", -1)).toBe(list)
    expect(shiftChatFolder(list, "c", 1)).toBe(list)
  })

  it("places a chat in a folder at a position, out of its old one", () => {
    const list = folders()
    const moved = placeChatInFolder(list, "t4", {
      folderId: "a",
      beforeThreadId: "t2",
    })
    expect(moved[0]!.thread_ids).toEqual(["t1", "t4", "t2", "t3"])
    expect(moved[1]!.thread_ids).toEqual([])

    const reordered = placeChatInFolder(list, "t3", {
      folderId: "a",
      beforeThreadId: "t1",
    })
    expect(reordered[0]!.thread_ids).toEqual(["t3", "t1", "t2"])

    const appended = placeChatInFolder(list, "t1", { folderId: "c" })
    expect(appended[2]!.thread_ids).toEqual(["t1"])
    expect(appended[0]!.thread_ids).toEqual(["t2", "t3"])
  })

  it("takes a chat out of every folder, and skips moves that change nothing", () => {
    const list = folders()
    const out = placeChatInFolder(list, "t2", null)
    expect(folderOfThread(out, "t2")).toBeUndefined()
    expect(placeChatInFolder(list, "t9", null)).toBe(list)
    expect(
      placeChatInFolder(list, "t2", { folderId: "a", beforeThreadId: "t3" })
    ).toBe(list)
    expect(
      placeChatInFolder(list, "t2", { folderId: "a", beforeThreadId: "t2" })
    ).toBe(list)
    expect(placeChatInFolder(list, "t2", { folderId: "missing" })).toBe(list)
  })

  it("files a dragged selection in its order", () => {
    const list = folders()
    const appended = placeChatsInFolder(list, ["t4", "t1"], { folderId: "c" })
    expect(appended[2]!.thread_ids).toEqual(["t4", "t1"])
    expect(appended[0]!.thread_ids).toEqual(["t2", "t3"])

    const before = placeChatsInFolder(list, ["t4", "t9"], {
      folderId: "a",
      beforeThreadId: "t2",
    })
    expect(before[0]!.thread_ids).toEqual(["t1", "t4", "t9", "t2", "t3"])

    // Dropped on one of its own rows: lands before the next chat that stays.
    const onItself = placeChatsInFolder(list, ["t1", "t2"], {
      folderId: "a",
      beforeThreadId: "t2",
    })
    expect(onItself[0]!.thread_ids).toEqual(["t1", "t2", "t3"])

    const out = removeChatsFromFolders(list, ["t1", "t4"])
    expect(out[0]!.thread_ids).toEqual(["t2", "t3"])
    expect(out[1]!.thread_ids).toEqual([])
  })

  it("puts moved chats back where they were for undo", () => {
    const list = folders()
    const placements = chatPlacements(list, ["t2", "t4", "t9"])
    expect(placements).toEqual([
      { threadId: "t2", folderId: "a", index: 1 },
      { threadId: "t4", folderId: "b", index: 0 },
      { threadId: "t9", folderId: null, index: -1 },
    ])
    const moved = placeChatsInFolder(list, ["t2", "t4", "t9"], {
      folderId: "c",
    })
    const restored = restoreChatPlacements(moved, placements)
    expect(restored.map((folder) => folder.thread_ids)).toEqual([
      ["t1", "t2", "t3"],
      ["t4"],
      [],
    ])
    expect(restoreChatPlacements(list, placements)).toBe(list)
  })

  it("brings a removed folder back at its place for undo", () => {
    const list = folders()
    const removed = removeChatFolder(list, "a")
    // t2 was filed elsewhere meanwhile; it stays there.
    const meanwhile = placeChatInFolder(removed, "t2", { folderId: "c" })
    const restored = restoreChatFolder(meanwhile, list[0]!, 0)
    expect(order(restored)).toEqual(["a", "b", "c"])
    expect(restored[0]!.thread_ids).toEqual(["t1", "t3"])
    expect(restored[2]!.thread_ids).toEqual(["t2"])
    expect(restoreChatFolder(list, list[0]!, 0)).toBe(list)
  })
})
