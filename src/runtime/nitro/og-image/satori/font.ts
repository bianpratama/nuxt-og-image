import { prefixStorage } from 'unstorage'
import type { OgImageRenderEventContext, ResolvedFontConfig } from '../../../types'
import { useNitroOrigin, useStorage } from '#imports'

const assets = prefixStorage(useStorage(), '/assets')

export async function loadFont({ e }: OgImageRenderEventContext, font: ResolvedFontConfig): Promise<ResolvedFontConfig> {
  const { name, weight } = font
  if (font.data)
    return font

  if (font.key && await assets.hasItem(font.key)) {
    const fontData = await assets.getItem<string>(font.key)
    // fontData is a base64 string, need to turn it into a buffer
    // buf is a string need to convert it to a buffer
    font.data = Buffer.from(fontData!, 'base64')
    return font
  }

  // TODO we may not need this anymore
  let data: ArrayBuffer | undefined
  // fetch local fonts
  if (font.path) {
    data = await e.$fetch(font.path, {
      baseURL: useNitroOrigin(e),
      responseType: 'arrayBuffer',
    })
  }
  else {
    data = await e.$fetch(`/__og-image__/font/${name}/${weight}.ttf`, {
      responseType: 'arrayBuffer',
      query: {
        font,
      },
    })
  }
  font.data = data
  return font
}
