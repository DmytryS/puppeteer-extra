import { AutomationExtraPlugin } from 'automation-extra-plugin'

import * as types from './types'

import { RecaptchaContentScript } from './content'
import * as TwoCaptcha from './provider/2captcha'

export const BuiltinSolutionProviders: types.SolutionProvider[] = [
  {
    id: TwoCaptcha.PROVIDER_ID,
    fn: TwoCaptcha.getSolutions,
  },
]

/**
 * A plugin to automatically detect and solve reCAPTCHAs.
 * @noInheritDoc
 */
export class RecaptchaPlugin extends AutomationExtraPlugin {
  static id = 'recaptcha'
  constructor(opts: Partial<types.PluginOptions>) {
    super(opts)
    this.debug('Initialized', this.opts)
  }

  get defaults(): types.PluginOptions {
    return {
      visualFeedback: true,
      throwOnError: false,
    }
  }

  get contentScriptOpts(): types.ContentScriptOpts {
    const { visualFeedback } = this.opts
    return {
      visualFeedback,
    }
  }

  private _generateContentScript(
    fn: 'findRecaptchas' | 'enterRecaptchaSolutions',
    data?: any
  ) {
    this.debug('_generateContentScript', fn, data)
    return `(async() => {
      const DATA = ${JSON.stringify(data || null)}
      const OPTS = ${JSON.stringify(this.contentScriptOpts)}

      ${RecaptchaContentScript.toString()}
      const script = new RecaptchaContentScript(OPTS, DATA)
      return script.${fn}()
    })()`
  }

  async findRecaptchas(page: types.Page | types.Frame) {
    this.debug('findRecaptchas')
    // As this might be called very early while recaptcha is still loading
    // we add some extra waiting logic for developer convenience.
    const hasRecaptchaScriptTag = await page.$(
      `script[src*="/recaptcha/api.js"]`
    )
    this.debug('hasRecaptchaScriptTag', !!hasRecaptchaScriptTag)
    if (hasRecaptchaScriptTag) {
      this.debug('waitForRecaptchaClient - start', new Date())
      await (page as types.Playwright.Page).waitForFunction(
        `
        (function() {
          return window.___grecaptcha_cfg && window.___grecaptcha_cfg.count
        })()
      `,
        { polling: 200, timeout: 10 * 1000 }
      )
      this.debug('waitForRecaptchaClient - end', new Date()) // used as timer
    }
    // Even without a recaptcha script tag we're trying, just in case.
    const evaluateReturn = await (page as types.Playwright.Page).evaluate(
      this._generateContentScript('findRecaptchas')
    )
    const response: types.FindRecaptchasResult = evaluateReturn as any
    this.debug('findRecaptchas', response)
    if (this.opts.throwOnError && response.error) {
      throw new Error(response.error)
    }
    return response
  }

  async getRecaptchaSolutions(
    captchas: types.CaptchaInfo[],
    provider?: types.SolutionProvider
  ) {
    this.debug('getRecaptchaSolutions')
    provider = provider || this.opts.provider
    if (
      !provider ||
      (!provider.token && !provider.fn) ||
      (provider.token && provider.token === 'XXXXXXX' && !provider.fn)
    ) {
      throw new Error('Please provide a solution provider to the plugin.')
    }
    let fn = provider.fn
    if (!fn) {
      const builtinProvider = BuiltinSolutionProviders.find(
        (p) => p.id === (provider || {}).id
      )
      if (!builtinProvider || !builtinProvider.fn) {
        throw new Error(
          `Cannot find builtin provider with id '${provider.id}'.`
        )
      }
      fn = builtinProvider.fn
    }
    const response = await fn.call(this, captchas, provider.token)
    response.error =
      response.error ||
      response.solutions.find((s: types.CaptchaSolution) => !!s.error)
    this.debug('getRecaptchaSolutions', response)
    if (response && response.error) {
      console.warn(
        'PuppeteerExtraPluginRecaptcha: An error occured during "getRecaptchaSolutions":',
        response.error
      )
    }
    if (this.opts.throwOnError && response.error) {
      throw new Error(response.error)
    }
    return response
  }

  async enterRecaptchaSolutions(
    page: types.Page | types.Frame,
    solutions: types.CaptchaSolution[]
  ) {
    this.debug('enterRecaptchaSolutions')
    const evaluateReturn = await (page as types.Playwright.Page).evaluate(
      this._generateContentScript('enterRecaptchaSolutions', {
        solutions,
      })
    )
    const response: types.EnterRecaptchaSolutionsResult = evaluateReturn as any
    response.error = response.error || response.solved.find((s) => !!s.error)
    this.debug('enterRecaptchaSolutions', response)
    if (this.opts.throwOnError && response.error) {
      throw new Error(response.error)
    }
    return response
  }

  async solveRecaptchas(
    page: types.Page | types.Frame
  ): Promise<types.SolveRecaptchasResult> {
    this.debug('solveRecaptchas')
    const response: types.SolveRecaptchasResult = {
      captchas: [],
      solutions: [],
      solved: [],
      error: null,
    }
    try {
      // If `this.opts.throwOnError` is set any of the
      // following will throw and abort execution.
      const { captchas, error: captchasError } = await this.findRecaptchas(page)
      response.captchas = captchas

      if (captchas.length) {
        const {
          solutions,
          error: solutionsError,
        } = await this.getRecaptchaSolutions(response.captchas)
        response.solutions = solutions

        const {
          solved,
          error: solvedError,
        } = await this.enterRecaptchaSolutions(page, response.solutions)
        response.solved = solved

        response.error = captchasError || solutionsError || solvedError
      }
    } catch (error) {
      response.error = error.toString()
    }
    this.debug('solveRecaptchas', response)
    if (this.opts.throwOnError && response.error) {
      throw new Error(response.error)
    }
    return response
  }

  private _addCustomMethods(prop: types.Page | types.Frame) {
    this.debug('_addCustomMethods', prop.url())
    prop.findRecaptchas = async () => this.findRecaptchas(prop)
    prop.getRecaptchaSolutions = async (
      captchas: types.CaptchaInfo[],
      provider?: types.SolutionProvider
    ) => this.getRecaptchaSolutions(captchas, provider)
    prop.enterRecaptchaSolutions = async (solutions: types.CaptchaSolution[]) =>
      this.enterRecaptchaSolutions(prop, solutions)
    // Add convenience methods that wraps all others
    prop.solveRecaptchas = async () => this.solveRecaptchas(prop)
  }

  async beforeContext(
    options: types.Playwright.BrowserContextOptions,
    browser: types.Browser
  ) {
    if (!this.env.isPuppeteerBrowser(browser)) {
      return
    }
    options.bypassCSP = true
  }

  async onPageCreated(page: types.Page) {
    this.debug('onPageCreated', page.url())

    if (this.env.isPuppeteerPage(page)) {
      // Make sure we can run our content script
      await page.setBypassCSP(true)
    }

    // Add custom page methods
    this._addCustomMethods(page)

    // Add custom methods to potential frames as well
    page.on('frameattached', (frame) => {
      if (!frame) return
      this._addCustomMethods(frame)
    })
  }

  private _addCustomMethodsToPages(pages: types.Page[]) {
    this.debug('_addCustomMethodsToPages', pages.length)
    for (const page of pages) {
      this._addCustomMethods(page)
      for (const frame of page.mainFrame().childFrames()) {
        this._addCustomMethods(frame)
      }
    }
  }

  /** Add additions to already existing pages and frames */
  async onBrowser(browser: types.Browser) {
    if (this.env.isPuppeteerBrowser(browser)) {
      const pages = await browser.pages()
      this._addCustomMethodsToPages(pages)
      return
    }
    if (this.env.isPlaywrightBrowser(browser)) {
      const pages: types.Playwright.Page[] = []
      for (const context of browser.contexts()) {
        context.pages().forEach((p) => pages.push(p))
      }
      this._addCustomMethodsToPages(pages)
      return
    }
  }
}

/** Default export, RecaptchaPlugin  */
const defaultExport = (options?: Partial<types.PluginOptions>) => {
  return new RecaptchaPlugin(options || {})
}

export default defaultExport
