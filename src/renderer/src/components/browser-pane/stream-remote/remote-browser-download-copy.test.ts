// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  toast: { success: vi.fn(), loading: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
  copyServerDownload: vi.fn(),
  cancelServerDownloadCopy: vi.fn()
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/rpc/environment-revisions/runtime-environment-revision', () => ({
  captureRuntimeEnvironmentRequestRevision: () => undefined
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn(async () => {}) }))
vi.mock('@/lib/files/os-open/local-file-manager-label', () => ({
  getLocalFileManager: () => 'finder'
}))

import { offerRemoteBrowserDownloadCopy } from './remote-browser-download-copy'

type Clickable = { action: { onClick: (event: { preventDefault: () => void }) => void } }
const click = (options: unknown): void =>
  (options as Clickable).action.onClick({ preventDefault: () => {} })

/** Clicks Save to this computer, then Cancel, and lets the copy end with `failure`. */
async function saveThenCancel(cancelAccepted: boolean, failure: Error): Promise<void> {
  let failCopy: (error: Error) => void = () => {}
  mocks.copyServerDownload.mockReturnValue(
    new Promise((_resolve, reject) => {
      failCopy = reject
    })
  )
  mocks.cancelServerDownloadCopy.mockResolvedValue(cancelAccepted)
  offerRemoteBrowserDownloadCopy({
    toastId: 'toast',
    target: { kind: 'environment', environmentId: 'server' },
    copyId: 'copy',
    savedOnServer: 'Saved on server',
    filename: 'report.pdf'
  })
  click(mocks.toast.success.mock.calls[0][1])
  click(mocks.toast.loading.mock.calls[0][1])
  failCopy(failure)
  await vi.waitFor(() =>
    expect(mocks.toast.error.mock.calls.length + mocks.toast.dismiss.mock.calls.length).toBe(1)
  )
}

beforeEach(() => {
  Object.assign(window, {
    api: {
      browser: {
        copyServerDownload: mocks.copyServerDownload,
        cancelServerDownloadCopy: mocks.cancelServerDownloadCopy
      }
    }
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('Cancel on a download being saved to this computer', () => {
  it('closes the toast when the copy was canceled', async () => {
    await saveThenCancel(true, new Error('Canceled.'))

    expect(mocks.toast.dismiss).toHaveBeenCalledWith('toast')
    expect(mocks.toast.error).not.toHaveBeenCalled()
  })

  it('still shows a failure when the Cancel came too late to stop the copy', async () => {
    const failure = new Error(
      'The partly saved file was kept at /Downloads/report.pdf and may be incomplete (EIO).'
    )
    await saveThenCancel(false, failure)

    expect(mocks.toast.dismiss).not.toHaveBeenCalled()
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Couldn't save {{filename}} to this computer.",
      expect.objectContaining({ description: failure.message })
    )
  })
})
