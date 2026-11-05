// Lets `node --test` run the TypeScript sources as they are: Node strips the types (22.18+), and this finds
// './puppet' as './puppet.ts', the way the bundler does. No test framework to install.
import { registerHooks } from 'node:module'

registerHooks({
  resolve(spec, ctx, next) {
    try {
      return next(spec, ctx)
    } catch (e) {
      if (spec.startsWith('.') && !/\.[cm]?[jt]s$/.test(spec)) return next(`${spec}.ts`, ctx)
      throw e
    }
  },
})
