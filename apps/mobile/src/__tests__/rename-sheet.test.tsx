import { describe, expect, it, jest } from "@jest/globals"
import { act, fireEvent, render, screen } from "@testing-library/react-native"
import { RenameSheet } from "@/components/rename-sheet"

describe("RenameSheet", () => {
  it("saves the latest text when Save arrives before the next render", async () => {
    const onSave = jest.fn(async (_name: string) => {})
    await render(
      <RenameSheet
        visible
        title=""
        onCancel={() => {}}
        onSave={onSave}
        fileName
      />
    )

    await fireEvent.changeText(screen.getByTestId("rename-input"), "M")
    const input = screen.getByTestId("rename-input")
    const save = screen.getByTestId("rename-save")

    // Deliver both native events in one React batch. Save still has the
    // handler from the render where the field contained only "M".
    await act(async () => {
      input.props.onChangeText("Map.tsx")
      save.props.onPress()
    })

    expect(onSave).toHaveBeenCalledWith("Map.tsx")
  })

  it("validates the latest text before saving in the same batch", async () => {
    const onSave = jest.fn(async (_name: string) => {})
    await render(
      <RenameSheet
        visible
        title=""
        onCancel={() => {}}
        onSave={onSave}
        fileName
        problem={(name) => (name === "README.md" ? "Name already taken" : null)}
      />
    )

    await fireEvent.changeText(screen.getByTestId("rename-input"), "M")
    const input = screen.getByTestId("rename-input")
    const save = screen.getByTestId("rename-save")

    await act(async () => {
      input.props.onChangeText("README.md")
      save.props.onPress()
    })

    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText("Name already taken")).toBeTruthy()
  })
})
