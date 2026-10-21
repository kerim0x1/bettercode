/** Request and model-picker data of the editor's inline AI edit. */
export interface InlineEditRequest {
  filePath: string
  language: string
  instruction: string
  selectedText: string
  isWholeFile: boolean
  selection: {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
  }
}

export interface InlineEditModel {
  id: string
  name: string
}

export interface InlineEditProvider {
  id: string
  name: string
  logo?: string
  invertDark?: boolean
  models: InlineEditModel[]
}
