import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

// The app's interface is English, like the desktop's. It used to mix in
// German labels ("Ordner", "Pfad blockiert", "NUR LESEN", German dates).
// This scans the app's code, not its comments, for German words, umlauts
// and the German date locale.

const APP_ROOT = path.resolve(import.meta.dirname, "..", "..")
const GERMAN =
  /\b(?:Pfad|blockiert|Datei|Dateien|DATEIEN|Ordner|Zeilen|Inhalt|Ergebnis|begrenzt|verfeinere|deine|Suche|fehlt|Aktualisieren|Verbindung|verbunden|Kopplung|koppeln|Gerät|Fehler|Keine|keine|nicht|und|oder|mit|für|wird|wurde|werden|Bitte|bitte|Zurück|zurück|Schließen|Öffnen|Speichern|Abbrechen|Laden|lädt|nutzt|ausschließlich|scannen|LESEN)\b|[äöüÄÖÜß]|de-DE/

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : sourceFiles(full)
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [full]
      : []
  })
}

/** The code with comments removed (whole-line and block comments). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

// The WebView pages are CodeMirror and xterm.js, built from their packages
// into one line each by scripts/build-mobile-pages.mjs: not the app's text.
// The pages' own code (editor/, terminal/) is scanned instead.
const GENERATED = new Set([
  path.join(APP_ROOT, "src", "editor", "editor-html.ts"),
  path.join(APP_ROOT, "src", "terminal", "terminal-html.ts"),
])

describe("interface language", () => {
  it("has no German text in the app", () => {
    const files = [
      ...sourceFiles(path.join(APP_ROOT, "src")).filter(
        (file) => !GENERATED.has(file)
      ),
      ...sourceFiles(path.join(APP_ROOT, "editor")),
      ...sourceFiles(path.join(APP_ROOT, "terminal")),
      path.join(APP_ROOT, "app.config.ts"),
    ]
    expect(files.length).toBeGreaterThan(20)
    const findings = files.flatMap((file) =>
      withoutComments(fs.readFileSync(file, "utf8"))
        .split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => GERMAN.test(line))
        .map(
          ({ line, index }) =>
            `${path.relative(APP_ROOT, file)}:${index + 1}: ${line.trim()}`
        )
    )
    expect(findings).toEqual([])
  })
})
