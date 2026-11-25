import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const downloads = vi.hoisted(() => ({ path: '' }))

vi.mock('electron', () => ({ app: { getPath: () => downloads.path } }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>()
  return { ...fs, link: vi.fn(fs.link), open: vi.fn(fs.open) }
})
vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  resolveEnvironment: vi.fn(async () => ({}))
}))
vi.mock('../../ipc/runtime-environments/requests/runtime-environment-revision-guard', () => ({
  runtimeEnvironmentRevisionFailure: () => null
}))
vi.mock('../../ipc/runtime-environments/catalog/runtime-environment-registry-root', () => ({
  getRuntimeEnvironmentRegistryRoot: () => '/registry'
}))
vi.mock(
  '../../ipc/runtime-environments/connections/runtime-environment-transport-generation',
  () => ({
    onRuntimeEnvironmentTransportGenerationRetired: () => () => {}
  })
)
vi.mock('../../ipc/runtime-environments/requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: vi.fn(async () => ({ ok: true })),
  subscribeRuntimeEnvironment: vi.fn()
}))

import { link, open } from 'node:fs/promises'
import { BROWSER_DOWNLOAD_COPY_FRAME_KIND } from '../../../shared/browser/downloads/browser-download-copy-stream'
import {
  callRuntimeEnvironment,
  subscribeRuntimeEnvironment
} from '../../ipc/runtime-environments/requests/runtime-environment-transport-routing'
import { browserDownloadDestinationReservations } from './browser-download-destination'
import {
  cancelBrowserServerDownloadCopy,
  copyBrowserServerDownloadHere
} from './browser-server-download-copy'

const fs = await vi.importActual<typeof FsPromises>('node:fs/promises')
const CONTENT = 'copied'

type StreamEvent = Parameters<Parameters<typeof subscribeRuntimeEnvironment>[5]['onEvent']>[0]
const response = (result: unknown): StreamEvent =>
  ({ type: 'response', response: { ok: true, result } }) as StreamEvent

/** The server streams CONTENT; `end` is held back while `holdEnd` is set. */
function serverSends({ holdEnd }: { holdEnd: boolean }): void {
  vi.mocked(subscribeRuntimeEnvironment).mockImplementation(async (...args) => {
    const { onEvent } = args[5]
    setTimeout(() => {
      onEvent(response({ type: 'start', size: CONTENT.length }))
      onEvent({
        type: 'binary',
        bytes: Uint8Array.from([BROWSER_DOWNLOAD_COPY_FRAME_KIND, ...Buffer.from(CONTENT)])
      })
      if (!holdEnd) {
        onEvent(response({ type: 'end' }))
      }
    }, 0)
    return { requestId: 'stream', close: () => {}, sendBinary: () => true }
  })
}

/** A Downloads volume without hard links, so the file is copied into a newly created one. */
function volumeWithoutLinks(onCreate?: () => void, closeError?: Error): void {
  vi.mocked(link).mockRejectedValue(Object.assign(new Error('no links'), { code: 'EPERM' }))
  vi.mocked(open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args)
    if (args[1] !== 'wx' || path.basename(String(args[0])).startsWith('.')) {
      return handle
    }
    onCreate?.()
    const close = handle.close.bind(handle)
    return Object.assign(handle, {
      close: async () => {
        await close()
        if (closeError) {
          throw closeError
        }
      }
    })
  })
}

const copy = (copyId: string) =>
  copyBrowserServerDownloadHere(
    { environmentId: 'server', copyId, filename: 'report.pdf' },
    new AbortController().signal
  )

beforeEach(async () => {
  downloads.path = await fs.mkdtemp(path.join(tmpdir(), 'server-download-copy-'))
})

afterEach(async () => {
  vi.mocked(link).mockImplementation(fs.link)
  vi.mocked(open).mockImplementation(fs.open)
  vi.mocked(callRuntimeEnvironment).mockClear()
  await fs.rm(downloads.path, { recursive: true, force: true })
})

describe('Save to this computer for a download on a paired server', () => {
  it('Cancel while the file arrives stops it and leaves nothing here', async () => {
    serverSends({ holdEnd: true })
    const result = copy('copy-1')
    await vi.waitFor(async () => expect(await fs.readdir(downloads.path)).toHaveLength(1))

    expect(cancelBrowserServerDownloadCopy('copy-1')).toBe(true)
    await expect(result).rejects.toThrow('Canceled.')
    expect(await fs.readdir(downloads.path)).toEqual([])
    // Its name is free again.
    const again = await browserDownloadDestinationReservations.reserveIncoming('report.pdf')
    browserDownloadDestinationReservations.release(again.reservationKey)
    expect(again.filename).toBe('report.pdf')
    expect(vi.mocked(callRuntimeEnvironment).mock.calls.map((call) => call[2])).toEqual([
      'browser.releaseDownloadCopy'
    ])
  })

  it('a Cancel that comes once the file is being moved into Downloads is refused, and it saves', async () => {
    serverSends({ holdEnd: false })
    let canceledAtMove: boolean | null = null
    volumeWithoutLinks(() => {
      canceledAtMove = cancelBrowserServerDownloadCopy('copy-2')
    })

    const { destinationPath } = await copy('copy-2')

    expect(canceledAtMove).toBe(false)
    expect(destinationPath).toBe(path.join(downloads.path, 'report.pdf'))
    expect(await fs.readFile(destinationPath, 'utf8')).toBe(CONTENT)
    expect(await fs.readdir(downloads.path)).toEqual(['report.pdf'])
  })

  it('a copy into Downloads that fails keeps the file and says so', async () => {
    serverSends({ holdEnd: false })
    volumeWithoutLinks(
      undefined,
      Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' })
    )
    const destinationPath = path.join(downloads.path, 'report.pdf')

    await expect(copy('copy-3')).rejects.toThrow(
      `The partly saved file was kept at ${destinationPath} and may be incomplete (EIO: i/o error, close).`
    )
    // The staging copy is gone; the kept file stays.
    expect(await fs.readdir(downloads.path)).toEqual(['report.pdf'])
    expect(cancelBrowserServerDownloadCopy('copy-3')).toBe(false)
  })
})
