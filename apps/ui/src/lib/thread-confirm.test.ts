import { afterEach, describe, expect, it, vi } from "vitest"
import { useSettingsStore } from "@/lib/settings-store"
import { archiveChatDialog, runThreadAction } from "@/lib/thread-confirm"

describe("runThreadAction", () => {
  afterEach(() => {
    useSettingsStore.setState({ confirmArchive: true, confirmDelete: true })
  })

  it("asks first while the confirm setting is on", () => {
    useSettingsStore.setState({ confirmArchive: true })
    const action = vi.fn()
    const onConfirm = vi.fn()
    const dialog = archiveChatDialog("Fix the build", action)
    runThreadAction("archive", dialog, onConfirm)
    expect(onConfirm).toHaveBeenCalledWith(dialog)
    expect(action).not.toHaveBeenCalled()
    expect(dialog.description).toContain('"Fix the build"')
  })

  it("runs at once while the confirm setting is off", () => {
    useSettingsStore.setState({ confirmDelete: false })
    const action = vi.fn()
    const onConfirm = vi.fn()
    runThreadAction(
      "delete",
      { title: "Delete chat?", description: "", action },
      onConfirm
    )
    expect(action).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("never deletes without a dialog to ask in, but still archives", () => {
    const deleteAction = vi.fn()
    runThreadAction("delete", {
      title: "Delete chat?",
      description: "",
      action: deleteAction,
    })
    expect(deleteAction).not.toHaveBeenCalled()

    const archiveAction = vi.fn()
    runThreadAction("archive", archiveChatDialog(undefined, archiveAction))
    expect(archiveAction).toHaveBeenCalledOnce()
  })
})
