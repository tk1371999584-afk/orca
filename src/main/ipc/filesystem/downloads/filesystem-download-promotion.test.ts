import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>()
  return { ...fs, link: vi.fn(fs.link), lstat: vi.fn(fs.lstat), open: vi.fn(fs.open) }
})

import { link, lstat, open } from 'node:fs/promises'
import { promoteDownloadedFileWithoutOverwrite } from './filesystem-download-promotion'

const fs = await vi.importActual<typeof FsPromises>('node:fs/promises')
const dirs: string[] = []

afterEach(async () => {
  vi.mocked(link).mockImplementation(fs.link)
  vi.mocked(lstat).mockImplementation(fs.lstat)
  vi.mocked(open).mockImplementation(fs.open)
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

type Trouble = 'write-error' | 'close-error' | 'cancel-mid-copy'

/**
 * Moves a finished download into Downloads on a volume without hard links, with trouble while it
 * is copied into the new file. `onTrouble` runs at that moment; `onInspect` runs whenever the
 * destination's name is looked up afterwards.
 */
async function copyWithTrouble(
  trouble: Trouble,
  hooks: { onTrouble?: () => Promise<void>; onInspect?: () => Promise<void> } = {}
) {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'download-promotion-'))
  dirs.push(dir)
  const tempPath = path.join(dir, '.part')
  const destinationPath = path.join(dir, 'report.pdf')
  await fs.writeFile(tempPath, 'copied')
  const controller = new AbortController()
  let troubled = false
  const troubleNow = async (): Promise<void> => {
    troubled = true
    await hooks.onTrouble?.()
  }

  vi.mocked(link).mockRejectedValue(Object.assign(new Error('no links'), { code: 'EPERM' }))
  vi.mocked(lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    const result = await fs.lstat(...args)
    if (troubled && args[0] === destinationPath) {
      await hooks.onInspect?.()
    }
    return result
  }) as typeof fs.lstat)
  vi.mocked(open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args)
    if (args[1] !== 'wx') {
      return handle
    }
    const write = handle.write.bind(handle) as (...a: unknown[]) => Promise<unknown>
    const close = handle.close.bind(handle)
    return Object.assign(handle, {
      // The source is 'copied': the first half lands, then the trouble, then the rest.
      write: async (...a: unknown[]) => {
        await write(Buffer.from('cop'))
        if (trouble === 'write-error') {
          await troubleNow()
          throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
            code: 'ENOSPC'
          })
        }
        if (trouble === 'cancel-mid-copy') {
          controller.abort(new Error('Canceled.'))
          await troubleNow()
        }
        await write(Buffer.from('ied'))
        return { bytesWritten: a[2] as number, buffer: a[0] }
      },
      close: async () => {
        await close()
        if (trouble === 'close-error') {
          await troubleNow()
          throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' })
        }
      }
    })
  })

  const result = promoteDownloadedFileWithoutOverwrite(
    tempPath,
    destinationPath,
    async () => path.join(dir, 'report (1).pdf'),
    controller.signal
  )
  return { dir, destinationPath, result }
}

/** Another app saves its own file under the same name (moved in, so it is a different file). */
async function anotherAppSaves(destinationPath: string): Promise<void> {
  const theirs = path.join(path.dirname(destinationPath), 'their-save')
  await fs.writeFile(theirs, 'theirs')
  await fs.rename(theirs, destinationPath)
}

describe('moving a download into Downloads on a volume without hard links', () => {
  it.each<[Trouble, string]>([
    ['write-error', 'ENOSPC: no space left on device, write'],
    ['close-error', 'EIO: i/o error, close']
  ])('reports a failed copy (%s) and keeps what it wrote', async (trouble, reason) => {
    const { dir, destinationPath, result } = await copyWithTrouble(trouble)

    await expect(result).rejects.toThrow(
      `The partly saved file was kept at ${destinationPath} and may be incomplete (${reason}).`
    )
    // Nothing at the name is removed; the staging copy is left for the caller to clean up.
    expect((await fs.readdir(dir)).sort()).toEqual(['.part', 'report.pdf'])
  })

  it.each<['write-error' | 'close-error', 'when the copy fails' | 'when Orca looks at the name']>([
    ['write-error', 'when the copy fails'],
    ['close-error', 'when the copy fails'],
    ['write-error', 'when Orca looks at the name'],
    ['close-error', 'when Orca looks at the name']
  ])('never removes a file another app saved under the name (%s, %s)', async (trouble, moment) => {
    let saved = false
    const save = async (): Promise<void> => {
      if (!saved) {
        saved = true
        await anotherAppSaves(destinationPath)
      }
    }
    const { dir, destinationPath, result } = await copyWithTrouble(
      trouble,
      moment === 'when the copy fails' ? { onTrouble: save } : { onInspect: save }
    )

    await expect(result).rejects.toThrow('may be incomplete')
    // An app that saves after Orca stopped looking at the name must keep its file too.
    await save()
    expect(await fs.readFile(destinationPath, 'utf8')).toBe('theirs')
    expect((await fs.readdir(dir)).sort()).toEqual(['.part', 'report.pdf'])
  })

  it('finishes a copy that a cancel reaches after it started, rather than leave part of it', async () => {
    const { dir, destinationPath, result } = await copyWithTrouble('cancel-mid-copy')

    await expect(result).resolves.toBe(destinationPath)
    expect(await fs.readFile(destinationPath, 'utf8')).toBe('copied')
    expect(await fs.readdir(dir)).toEqual(['report.pdf'])
  })
})
