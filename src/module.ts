import { readFile, writeFile } from 'node:fs/promises'
import type { NitroRouteRules } from 'nitropack'
import {
  addComponent,
  addImports,
  addServerHandler, addServerPlugin,
  addTemplate,
  createResolver,
  defineNuxtModule,
} from '@nuxt/kit'
import { execa } from 'execa'
import chalk from 'chalk'
import defu from 'defu'
import { createRouter as createRadixRouter, toRouteMatcher } from 'radix3'
import { joinURL, withBase } from 'ufo'
import { relative } from 'pathe'
import type { Browser } from 'playwright-core'
import { tinyws } from 'tinyws'
import sirv from 'sirv'
import type { SatoriOptions } from 'satori'
import { copy, mkdirp, pathExists } from 'fs-extra'
import { provider } from 'std-env'
import createBrowser from './runtime/nitro/providers/browser/node'
import { screenshot } from './runtime/browserUtil'
import type { OgImageOptions, ScreenshotOptions } from './types'
import { setupPlaygroundRPC } from './rpc'
import { extractOgImageOptions } from './runtime/nitro/utils-pure'

export interface ModuleOptions {
  /**
   * The hostname of your website.
   * @deprecated use `siteUrl`
   */
  host?: string
  siteUrl: string
  defaults: OgImageOptions
  fonts: `${string}:${number}`[]
  satoriOptions: Partial<SatoriOptions>
  forcePrerender: boolean
  satoriProvider: boolean
  browserProvider: boolean
  experimentalInlineWasm: boolean
  playground: boolean
  /**
   * Enables debug logs and a debug endpoint.
   */
  debug: boolean
}

const PATH = '/__nuxt_og_image__'
const PATH_ENTRY = `${PATH}/entry`
const PATH_PLAYGROUND = `${PATH}/client`

const edgeProvidersSupported = [
  'cloudflare',
  'cloudflare-pages',
  'vercel-edge',
  'netlify-edge',
]

export interface ModuleHooks {
  'og-image:config': (config: ModuleOptions) => Promise<void> | void
  'og-image:prerenderScreenshots': (queue: OgImageOptions[]) => Promise<void> | void
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nuxt-og-image',
    compatibility: {
      nuxt: '^3.3.1',
      bridge: false,
    },
    configKey: 'ogImage',
  },
  defaults(nuxt) {
    const siteUrl = process.env.NUXT_PUBLIC_SITE_URL || process.env.NUXT_SITE_URL || nuxt.options.runtimeConfig.public?.siteUrl || nuxt.options.runtimeConfig.siteUrl
    // @ts-expect-error untyped
    const isEdgeProvider = edgeProvidersSupported.includes(process.env.NITRO_PRESET || '') || edgeProvidersSupported.includes(nuxt.options.nitro.preset)
    return {
      // when we run `nuxi generate` we need to force prerendering
      forcePrerender: !nuxt.options.dev && nuxt.options._generate,
      siteUrl,
      defaults: {
        component: 'OgImageBasic',
        width: 1200,
        height: 630,
      },
      satoriProvider: true,
      // disable browser in edge environments
      browserProvider: !isEdgeProvider,
      fonts: [],
      satoriOptions: {},
      experimentalInlineWasm: process.env.NITRO_PRESET === 'netlify-edge' || nuxt.options.nitro.preset === 'netlify-edge' || false,
      playground: process.env.NODE_ENV === 'development' || nuxt.options.dev,
    }
  },
  async setup(config, nuxt) {
    const { resolve } = createResolver(import.meta.url)

    // allow config fallback
    config.siteUrl = config.siteUrl || config.host!

    // default font is inter
    if (!config.fonts.length)
      config.fonts = ['Inter:400', 'Inter:700']

    const distResolve = (p: string) => {
      const cwd = resolve('.')
      if (cwd.endsWith('/dist'))
        return resolve(p)
      return resolve(`../dist/${p}`)
    }

    nuxt.options.experimental.componentIslands = true

    // paths.d.ts
    addTemplate({
      filename: 'nuxt-og-image.d.ts',
      getContents: () => {
        return `// Generated by nuxt-og-image
interface NuxtOgImageNitroRules {
  ogImage?: false | Record<string, any>
}
declare module 'nitropack' {
  interface NitroRouteRules extends NuxtOgImageNitroRules {}
  interface NitroRouteConfig extends NuxtOgImageNitroRules {}
}
export {}
`
      },
    })

    nuxt.hooks.hook('prepare:types', ({ references }) => {
      references.push({ path: resolve(nuxt.options.buildDir, 'nuxt-og-image.d.ts') })
    })

    addServerHandler({
      lazy: true,
      handler: resolve('./runtime/nitro/middleware/og.png'),
    })

    ;['html', 'options', 'svg', 'vnode', 'font', 'debug']
      .forEach((type) => {
        if (type !== 'debug' || config.debug) {
          addServerHandler({
            lazy: true,
            route: `/api/og-image-${type}`,
            handler: resolve(`./runtime/nitro/routes/${type}`),
          })
        }
      })

    // eslint-disable-next-line @typescript-eslint/prefer-ts-expect-error
    // @ts-ignore runtime type
    nuxt.hook('devtools:customTabs', (iframeTabs) => {
      iframeTabs.push({
        name: 'ogimage',
        title: 'OG Image',
        icon: 'carbon:image-search',
        view: {
          type: 'iframe',
          src: '/__nuxt_og_image__/client/',
        },
      })
    })

    // Setup playground. Only available in development
    if (config.playground) {
      const playgroundDir = distResolve('./client')
      const {
        middleware: rpcMiddleware,
      } = setupPlaygroundRPC(nuxt, config)
      nuxt.hook('vite:serverCreated', async (server) => {
        server.middlewares.use(PATH_ENTRY, tinyws() as any)
        server.middlewares.use(PATH_ENTRY, rpcMiddleware as any)
        // serve the front end in production
        if (await pathExists(playgroundDir))
          server.middlewares.use(PATH_PLAYGROUND, sirv(playgroundDir, { single: true, dev: true }))
      })
      // allow /__og_image__ to be proxied
      addServerHandler({
        handler: resolve('./runtime/nitro/middleware/playground'),
      })
    }

    nuxt.options.optimization.treeShake.composables.client['nuxt-og-image'] = []
    ;['defineOgImageDynamic', 'defineOgImageStatic', 'defineOgImageScreenshot']
      .forEach((name) => {
        addImports({
          name,
          from: resolve('./runtime/composables/defineOgImage'),
        })
        nuxt.options.optimization.treeShake.composables.client['nuxt-og-image'].push(name)
      })

    await addComponent({
      name: 'OgImageBasic',
      filePath: resolve('./runtime/components/OgImageBasic.island.vue'),
      island: true,
    })

    ;['OgImageStatic', 'OgImageDynamic', 'OgImageScreenshot']
      .forEach((name) => {
        addComponent({
          name,
          filePath: resolve(`./runtime/components/${name}`),
        })
      })

    const runtimeDir = resolve('./runtime')
    nuxt.options.build.transpile.push(runtimeDir)

    addServerPlugin(resolve('./runtime/nitro/plugins/prerender'))

    // get public dir
    const moduleAssetDir = resolve('./runtime/public-assets')
    const assetDirs = [
      resolve(nuxt.options.rootDir, nuxt.options.dir.public),
      moduleAssetDir,
    ]
    nuxt.hooks.hook('modules:done', async () => {
      // allow other modules to modify runtime data
      // @ts-expect-error untyped
      nuxt.hooks.callHook('og-image:config', config)
      // @ts-expect-error untyped
      nuxt.options.runtimeConfig['nuxt-og-image'] = { ...config, assetDirs }
    })
    const useSatoriWasm = provider === 'stackblitz'

    nuxt.hooks.hook('nitro:config', async (nitroConfig) => {
      nitroConfig.externals = defu(nitroConfig.externals || {}, {
        inline: [runtimeDir],
      })

      nitroConfig.publicAssets = nitroConfig.publicAssets || []
      nitroConfig.publicAssets.push({ dir: moduleAssetDir, maxAge: 31536000 })

      const providerPath = `${runtimeDir}/nitro/providers`

      const nitroPreset = (nuxt.options.nitro.preset || process.env.NITRO_PRESET)

      const isNodeNitroServer = !nitroPreset || nitroPreset === 'node'

      if (config.browserProvider) {
        // browser can only work in node runtime at the moment
        nitroConfig.virtual!['#nuxt-og-image/browser'] = (nuxt.options.dev || process.env.prerender || isNodeNitroServer)
          ? `
import node from '${providerPath}/browser/node'

export default async function() {
  return node
}
`
          : `export default async function() {
 return () => {}
}
`
      }

      if (config.satoriProvider) {
        nitroConfig.virtual!['#nuxt-og-image/satori'] = `import satori from '${providerPath}/satori/${useSatoriWasm ? 'webworker' : 'node'}'
export default async function() {
  return satori
}`

        nitroConfig.virtual!['#nuxt-og-image/svg2png'] = `
import svg2png from '${providerPath}/svg2png/universal'
export default async function() {
 return svg2png
}`
      }

      nitroConfig.virtual!['#nuxt-og-image/provider'] = `
${config.satoriProvider ? `import satori from '${relative(nuxt.options.rootDir, resolve('./runtime/nitro/renderers/satori'))}'` : ''}
${config.browserProvider ? `import browser from '${relative(nuxt.options.rootDir, resolve('./runtime/nitro/renderers/browser'))}'` : ''}

export async function useProvider(provider) {
  if (provider === 'satori')
    return ${config.satoriProvider ? 'satori' : 'null'}
  if (provider === 'browser')
    return ${config.browserProvider ? 'browser' : 'null'}
  return null
}
      `
    })

    nuxt.hooks.hook('nitro:init', async (nitro) => {
      let screenshotQueue: OgImageOptions[] = []

      nitro.hooks.hook('compiled', async (_nitro) => {
        if (edgeProvidersSupported.includes(_nitro.options.preset)) {
          await copy(resolve('./runtime/public-assets/inter-latin-ext-400-normal.woff'), resolve(_nitro.options.output.publicDir, 'inter-latin-ext-400-normal.woff'))
          await copy(resolve('./runtime/public-assets/inter-latin-ext-700-normal.woff'), resolve(_nitro.options.output.publicDir, 'inter-latin-ext-700-normal.woff'))
          if (!config.experimentalInlineWasm) {
            await copy(resolve('./runtime/public-assets/svg2png.wasm'), resolve(_nitro.options.output.serverDir, 'svg2png.wasm'))
            if (useSatoriWasm)
              await copy(resolve('./runtime/public-assets/yoga.wasm'), resolve(_nitro.options.output.serverDir, 'yoga.wasm'))
          }
          // need to replace the token in entry
          const configuredEntry = nitro.options.rollupConfig?.output.entryFileNames
          const entryFile = typeof configuredEntry === 'string' ? configuredEntry : 'index.mjs'
          const indexFile = resolve(_nitro.options.output.serverDir, entryFile)
          if (await pathExists(indexFile)) {
            let indexContents = (await readFile(indexFile, 'utf-8'))
            if (_nitro.options.preset.includes('vercel')) {
              // fix for vercel
              indexContents = indexContents.replace('.cwd(),', '?.cwd || "/",')
            }
            if (!config.experimentalInlineWasm) {
              await writeFile(indexFile, indexContents
                .replace('"/* NUXT_OG_IMAGE_SVG2PNG_WASM */"', 'import("./svg2png.wasm").then(m => m.default || m)')
                .replace('"/* NUXT_OG_IMAGE_YOGA_WASM */"', 'import("./yoga.wasm").then(m => m.default || m)'),
              )
            }
            else {
              // read the wasm to a base 64 string
              const svg2pngWasm = await readFile(resolve('./runtime/public-assets/svg2png.wasm'), 'base64')
              const yogaWasm = await readFile(resolve('./runtime/public-assets/yoga.wasm'), 'base64')
              await writeFile(indexFile, indexContents
                .replace('"/* NUXT_OG_IMAGE_SVG2PNG_WASM */"', `Buffer.from("${svg2pngWasm}", "base64")`)
                .replace('"/* NUXT_OG_IMAGE_YOGA_WASM */"', `Buffer.from("${yogaWasm}", "base64")`),
              )
            }
          }
        }
      })

      const _routeRulesMatcher = toRouteMatcher(
        createRadixRouter({ routes: nitro.options.routeRules }),
      )

      nitro.hooks.hook('prerender:generate', async (ctx) => {
        // avoid scanning files and the og:image route itself
        if (ctx.route.includes('.'))
          return

        const html = ctx.contents

        // we need valid _contents to scan for ogImage options and know the route is good
        if (!html)
          return

        const extractedOptions = extractOgImageOptions(html)
        const routeRules: NitroRouteRules = defu({}, ..._routeRulesMatcher.matchAll(ctx.route).reverse())
        if (!extractedOptions || routeRules.ogImage === false)
          return

        const entry: OgImageOptions = {
          route: ctx.route,
          path: extractedOptions.component ? `/api/og-image-html?path=${ctx.route}` : ctx.route,
          ...extractedOptions,
          ...(routeRules.ogImage || {}),
        }

        // if we're running `nuxi generate` we prerender everything (including dynamic)
        if ((nuxt.options._generate || entry.static) && entry.provider === 'browser')
          screenshotQueue.push(entry)
      })

      if (nuxt.options.dev)
        return

      const captureScreenshots = async () => {
        // call hook
        // @ts-expect-error runtime hook
        await nuxt.callHook('og-image:prerenderScreenshots', screenshotQueue)

        if (screenshotQueue.length === 0)
          return

        // avoid problems by installing playwright
        nitro.logger.info('Ensuring chromium install for og:image generation...')
        const installChromeProcess = execa('npx', ['playwright', 'install', 'chromium'], {
          stdio: 'inherit',
        })
        installChromeProcess.stderr?.pipe(process.stderr)
        await new Promise((resolve) => {
          installChromeProcess.on('exit', (e) => {
            if (e !== 0)
              nitro.logger.error('Failed to install Playwright dependency for og:image generation. Trying anyway...')
            resolve(true)
          })
        })

        const previewProcess = execa('npx', ['serve', nitro.options.output.publicDir])
        let browser: Browser | null = null
        try {
          previewProcess.stderr?.pipe(process.stderr)
          // wait until we get a message which says "Accepting connections"
          const host = (await new Promise<string>((resolve) => {
            previewProcess.stdout?.on('data', (data) => {
              if (data.includes('Accepting connections at')) {
                // get the url from data and return it as the promise
                resolve(data.toString().split('Accepting connections at ')[1])
              }
            })
          })).trim()
          browser = await createBrowser()
          if (browser) {
            nitro.logger.info(`Prerendering ${screenshotQueue.length} og:image screenshots...`)

            // normalise
            for (const entry of screenshotQueue) {
              // allow inserting items into the queue via hook
              if (entry.route && Object.keys(entry).length === 1) {
                const html = await $fetch(entry.route, { baseURL: withBase(nuxt.options.app.baseURL, host) })
                const extractedOptions = extractOgImageOptions(html)
                const routeRules: NitroRouteRules = defu({}, ..._routeRulesMatcher.matchAll(entry.route).reverse())
                Object.assign(entry, {
                  // @ts-expect-error runtime
                  path: extractedOptions.component ? `/api/og-image-html?path=${entry.route}` : entry.route,
                  ...extractedOptions,
                  ...(routeRules.ogImage || {}),
                })
              }
              // if we're rendering a component let's fetch the html, it will have everything we need
              if (entry.component)
                entry.html = await globalThis.$fetch(entry.path)
            }

            for (const k in screenshotQueue) {
              const entry = screenshotQueue[k]
              const start = Date.now()
              let hasError = false
              const dirname = joinURL(nitro.options.output.publicDir, entry.route, '/__og_image__/')
              const filename = joinURL(dirname, '/og.png')
              try {
                const imgBuffer = await screenshot(browser, {
                  ...(config.defaults as ScreenshotOptions || {}),
                  ...(entry || {}),
                  host,
                })
                try {
                  await mkdirp(dirname)
                }
                catch (e) {}
                await writeFile(filename, imgBuffer)
              }
              catch (e) {
                hasError = true
                console.error(e)
              }
              const generateTimeMS = Date.now() - start
              nitro.logger.log(chalk[hasError ? 'red' : 'gray'](
                `  ${Number(k) === screenshotQueue.length - 1 ? '└─' : '├─'} /${relative(nitro.options.output.publicDir, filename)} (${generateTimeMS}ms) ${Math.round((Number(k) + 1) / (screenshotQueue.length) * 100)}%`,
              ))
            }
          }
          else {
            nitro.logger.log(chalk.red('Failed to create a browser to create og:images.'))
          }
        }
        catch (e) {
          console.error(e)
        }
        finally {
          await browser?.close()
          previewProcess.kill()
        }
        screenshotQueue = []
      }

      if (nuxt.options._generate) {
        // SSR mode
        nitro.hooks.hook('rollup:before', async () => {
          await captureScreenshots()
        })

        // SSG mode
        nitro.hooks.hook('close', async () => {
          await captureScreenshots()
        })
      }
    })
  },
})
