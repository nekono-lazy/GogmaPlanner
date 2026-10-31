import type { ExportRoot, ISODateTimeString } from '../../domain/models/publicTypes'

/*
 * The Export text and the summary the Settings screen shows in its place
 * (`docs/PLANNER_SPEC.md` 19.9, `docs/UI_FLOW.md` 14). Pure functions over an
 * Export root that `ImportExportService` already built and validated: no
 * Dexie, no DOM, no Blob, no Clipboard API.
 */

/**
 * What the Export Dialog shows about one backup instead of its JSON text. It
 * is derived from the very root that was serialized, so it never needs the
 * JSON parsed again or the database read again, and it holds no entity body.
 */
export interface ExportSummary {
  /** The root's own `exportedAt` (the Service clock), not the filename time. */
  exportedAt: ISODateTimeString
  /** The UTF-8 byte length of the JSON text: the size of the saved file. */
  jsonByteLength: number
  counts: {
    targetWeapons: number
    ownedWeapons: number
    buildListEntries: number
    productionPlans: number
    executionHistory: number
  }
}

/** One Export: the JSON text that is saved and copied, and its summary. */
export interface ExportBackup {
  json: string
  summary: ExportSummary
}

/**
 * The Export root as compact JSON. No indentation: nothing renders the text,
 * so whitespace would only add characters and memory. Import reads it the
 * same way whatever the whitespace.
 */
export function serializeExportRoot(root: ExportRoot): string {
  return JSON.stringify(root)
}

/**
 * The number of bytes `text` takes in UTF-8, counted over its UTF-16 code
 * units without encoding it (a large Export is never copied for a size). A
 * surrogate pair is one 4-byte code point; a lone surrogate counts 3 bytes,
 * the U+FFFD that `TextEncoder` and `Blob` write in its place.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

/** The summary of `root`, whose serialization is `json`. */
export function summarizeExportRoot(root: ExportRoot, json: string): ExportSummary {
  return {
    exportedAt: root.exportedAt,
    jsonByteLength: utf8ByteLength(json),
    counts: {
      targetWeapons: root.targetWeapons.length,
      ownedWeapons: root.ownedWeapons.length,
      buildListEntries: root.buildListEntries.length,
      productionPlans: root.productionPlans.length,
      executionHistory: root.executionHistory.length,
    },
  }
}
