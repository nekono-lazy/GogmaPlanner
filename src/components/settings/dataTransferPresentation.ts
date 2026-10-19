import type { DomainValidationIssue } from '../../domain/models/publicTypes'
import {
  DataTransferError,
  type ImportPreparationResult,
} from '../../services/dataTransfer/importExportService'

/*
 * Presentation of the Settings screen's data management (`docs/UI_FLOW.md` 14):
 * the Japanese feedback for Export / Import / clear outcomes, the backup
 * filename, and the browser side of the Export JSON (file download and
 * clipboard write). It decides nothing about the data: every validation,
 * migration and write decision stays in `ImportExportService`, and this module
 * only turns its typed outcomes into sentences.
 */

/** The one Data Transfer read / write running at a time (`docs/UI_FLOW.md` 14). */
export type DataTransferOperation =
  | 'export'
  | 'import_prepare'
  | 'import_apply'
  | 'clear'
  | null

export interface DataTransferFeedback {
  severity: 'success' | 'error'
  message: string
  /** Domain validation issues shown as a bounded, scrollable list; empty when none apply. */
  issues: readonly string[]
}

/** Where the Import text came from; it only chooses the sentence of a refusal. */
export type ImportTextSource = 'paste' | 'file'

/** The filename prefix of the downloaded backup; a UI convenience, not a Domain contract. */
export const EXPORT_DOWNLOAD_FILENAME_PREFIX = 'gogma-artian-planner-backup'

function padDigits(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/**
 * `gogma-artian-planner-backup_yyyyMMddHHmmss.json` in browser local time. No
 * `:` or `/`, so every filesystem accepts it. The timestamp names the file only;
 * it is not the Export root's `exportedAt`, which the Service sets.
 */
export function backupFilename(at: Date): string {
  const stamp = [
    padDigits(at.getFullYear(), 4),
    padDigits(at.getMonth() + 1, 2),
    padDigits(at.getDate(), 2),
    padDigits(at.getHours(), 2),
    padDigits(at.getMinutes(), 2),
    padDigits(at.getSeconds(), 2),
  ].join('')
  return `${EXPORT_DOWNLOAD_FILENAME_PREFIX}_${stamp}.json`
}

export const dataTransferSuccessMessages = {
  exportFile: 'バックアップファイルを出力しました。',
  exportCopy: 'クリップボードにコピーしました。',
  import: 'データをインポートしました。',
  clear: 'すべてのデータを削除し、初期状態に戻しました。',
} as const

const UNCHANGED_NOTE = '保存済みデータは変更されていません。'

/** One issue line for the user: the path locates it, the Domain message names it. */
export function formatValidationIssue(issue: DomainValidationIssue): string {
  return issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`
}

function success(message: string): DataTransferFeedback {
  return { severity: 'success', message, issues: [] }
}

function failure(message: string, issues: readonly DomainValidationIssue[] = []): DataTransferFeedback {
  return { severity: 'error', message, issues: issues.map(formatValidationIssue) }
}

/** The Export Dialog's JSON was handed to the browser download. */
export function exportFileSavedFeedback(): DataTransferFeedback {
  return success(dataTransferSuccessMessages.exportFile)
}

/** The browser refused the download before it started; the JSON stays on screen. */
export function exportFileSaveFailedFeedback(): DataTransferFeedback {
  return failure(`バックアップファイルを出力できませんでした。JSON欄から手動でコピーするか、再度お試しください。${UNCHANGED_NOTE}`)
}

/** The Export Dialog's JSON was written to the clipboard. */
export function exportCopiedFeedback(): DataTransferFeedback {
  return success(dataTransferSuccessMessages.exportCopy)
}

/**
 * The clipboard write was refused or is unavailable. The browser error is never
 * shown; the user is sent to the JSON field, which stays selectable.
 */
export function exportCopyFailedFeedback(): DataTransferFeedback {
  return failure('クリップボードにコピーできませんでした。JSON欄から手動でコピーしてください。')
}

/** Export never writes, so every failure leaves the data as it was. */
export function exportFailedFeedback(error: unknown): DataTransferFeedback {
  if (error instanceof DataTransferError) {
    switch (error.code) {
      case 'export_state_invalid':
        return failure(
          `現在の保存データに整合性の問題があるため、エクスポートできませんでした。${UNCHANGED_NOTE}`,
          error.validationIssues,
        )
      case 'transaction_failed':
        return failure(`保存データを読み取れなかったため、エクスポートできませんでした。${UNCHANGED_NOTE}`)
      case 'invalid_import':
        break
    }
  }
  return failure(`エクスポート中に予期しないエラーが発生しました。${UNCHANGED_NOTE}`)
}

/** The selected file could not be read as text at all (before any JSON parse). */
export function importFileReadFailedFeedback(): DataTransferFeedback {
  return failure(`選択したファイルを読み取れませんでした。${UNCHANGED_NOTE}`)
}

const importSourceSubjects = {
  paste: { text: '貼り付けた内容', backup: 'このバックアップデータ' },
  file: { text: '選択したファイル', backup: 'このバックアップファイル' },
} as const satisfies Record<ImportTextSource, { text: string; backup: string }>

/** A refused `prepareImportJson()`: nothing was written and no confirmation is asked. */
export function importPreparationFailedFeedback(
  result: Extract<ImportPreparationResult, { ok: false }>,
  source: ImportTextSource,
): DataTransferFeedback {
  const subject = importSourceSubjects[source]
  switch (result.code) {
    case 'invalid_json':
      return failure(`${subject.text}をJSONとして読み取れませんでした。${UNCHANGED_NOTE}`, result.issues)
    case 'invalid_import':
      return failure(
        `${subject.backup}はインポートできません。インポートできないデータが含まれているか、保存形式が現在のアプリで読み込めません。${UNCHANGED_NOTE}`,
        result.issues,
      )
  }
}

/** `prepareImportJson()` threw instead of returning its typed refusal. */
export function importPreparationThrewFeedback(source: ImportTextSource): DataTransferFeedback {
  return failure(`${importSourceSubjects[source].text}を確認できませんでした。${UNCHANGED_NOTE}`)
}

export function importSucceededFeedback(): DataTransferFeedback {
  return success(dataTransferSuccessMessages.import)
}

/** A failed `applyImport()`: the transaction rolled back, so the previous data stays. */
export function importApplyFailedFeedback(error: unknown): DataTransferFeedback {
  if (error instanceof DataTransferError) {
    switch (error.code) {
      case 'invalid_import':
        return failure(`このバックアップファイルはインポートできません。${UNCHANGED_NOTE}`, error.validationIssues)
      case 'transaction_failed':
        return failure(`データをインポートできませんでした。${UNCHANGED_NOTE}`)
      case 'export_state_invalid':
        break
    }
  }
  return failure(`インポート中に予期しないエラーが発生しました。${UNCHANGED_NOTE}`)
}

export function clearSucceededFeedback(): DataTransferFeedback {
  return success(dataTransferSuccessMessages.clear)
}

/** A failed `clearAllData()`: the transaction rolled back, so the previous data stays. */
export function clearFailedFeedback(): DataTransferFeedback {
  return failure(`データを削除できませんでした。${UNCHANGED_NOTE}`)
}

/**
 * Writes text to the clipboard through the asynchronous Clipboard API only. It
 * rejects when the API is missing or refused (an insecure context, a denied
 * permission); the caller turns that into `exportCopyFailedFeedback()`. It is
 * never called from the Domain or the Service, and it never reads the clipboard.
 */
export async function writeClipboardText(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
    throw new Error('The Clipboard API is unavailable.')
  }
  await clipboard.writeText(text)
}

/**
 * The browser side of the Export Dialog, injectable so a test can refuse the
 * clipboard or fix the clock. Neither member touches saved data.
 */
export interface DataTransferBrowserAdapter {
  writeClipboardText(text: string): Promise<void>
  /** The local time that names the backup file. */
  now(): Date
}

export const defaultDataTransferBrowserAdapter: DataTransferBrowserAdapter = {
  writeClipboardText,
  now: () => new Date(),
}

/**
 * Saves JSON text as a file through the browser only: a UTF-8 JSON Blob, an
 * object URL and a `download` anchor. The object URL is released once the
 * click was dispatched; no data is sent anywhere.
 */
export function downloadJsonFile(json: string, filename: string): void {
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    try {
      anchor.click()
    } finally {
      anchor.remove()
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}
