// 把业务模块打成 Node 可执行的 ESM 包，供 scripts/verify-*.cjs 直接 import 断言。
const path = require('path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')

async function main() {
  await esbuild.build({
    entryPoints: [path.join(root, 'scripts/test-entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: '/tmp/release-bundle.mjs',
    alias: { '@': path.join(root, 'src') },
    logLevel: 'silent',
  })
  await esbuild.build({
    entryPoints: [path.join(root, 'scripts/migrate-entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: '/tmp/migrate-bundle.mjs',
    alias: { '@': path.join(root, 'src') },
    logLevel: 'silent',
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
