/**
 * The wallet record codec: the page record is stored as base64 of its JSON text. The same codec reads it back.
 */
import { customJsonStringify } from '@/utils/utils'

type Loose = Record<string, any>

export const parseInitRaw = (b64: string): Loose | null => {
  try {
    const data = JSON.parse(Buffer.from(b64, 'base64').toString())
    return data && typeof data === 'object' ? data : null
  } catch {
    return null
  }
}

export const encodeInitRaw = (data: Loose): string => Buffer.from(customJsonStringify(data)).toString('base64')
