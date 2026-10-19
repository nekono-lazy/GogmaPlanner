import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function check(condition, message) {
  if (!condition) throw new Error(message)
}
function lexists(file) {
  try { fs.lstatSync(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
function safeFile(file) {
  const full = path.resolve(file)
  let current = path.parse(full).root
  for (const part of full.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    check(!fs.lstatSync(current).isSymbolicLink(), `Symlink/junction refused: ${current}`)
  }
  const stat = fs.lstatSync(full)
  check(stat.isFile() && stat.nlink === 1, `Non-regular or hardlinked file: ${full}`)
  return fs.readFileSync(full)
}

export function packageLicenses(root) {
  const generatedInventory = safeFile(path.join(root, 'dist', 'licenses.md'))
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const body = safeFile(path.join(root, file))
    check(body.length > 0, `Empty license: ${file}`)
    const destination = path.join(root, 'dist', file)
    // Check every parent, even before a new destination exists.
    const parent = path.dirname(destination)
    check(fs.statSync(parent).isDirectory(), 'Missing dist')
    safeFile(path.join(root, 'dist', 'index.html'))
    if (lexists(destination)) safeFile(destination)
    fs.writeFileSync(destination, body)
  }
  check(generatedInventory.equals(safeFile(path.join(root, 'dist', 'licenses.md'))), 'Vite license inventory changed during packaging')
}

export function verifyDist(root, expectedBuildId) {
  check(path.isAbsolute(root), 'Package directory must be absolute')
  check(/^[a-f0-9]{40}$/u.test(expectedBuildId), 'Use an explicit full build ID')
  const dist = path.join(root, 'dist')
  const files = []
  function visit(dir) {
    check(!fs.lstatSync(dir).isSymbolicLink(), `Symlink/junction refused: ${dir}`)
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      check(!fs.lstatSync(full).isSymbolicLink(), `Symlink/junction refused: ${full}`)
      if (entry.isDirectory()) visit(full)
      else {
        safeFile(full)
        files.push(path.relative(dist, full).split(path.sep).join('/'))
      }
    }
  }
  safeFile(path.join(root, 'dist', 'index.html'))
  visit(dist)
  const rootFiles = ['index.html', 'version.json', 'licenses.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']
  for (const file of files) {
    check(rootFiles.includes(file) || /^assets\/[A-Za-z0-9_.-]+\.(?:js|css|webp)$/u.test(file), `Unapproved distribution file: ${file}`)
    check(!/docs|research|benchmark|AGENTS|CLAUDE|source.?map/iu.test(file), `Unapproved distribution file: ${file}`)
  }
  for (const file of rootFiles) check(files.includes(file), `Missing distribution file: ${file}`)
  const license = safeFile(path.join(dist, 'licenses.md'))
  check(license.length > 0, 'Missing dist/licenses.md')
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    const original = safeFile(path.join(root, file))
    check(original.length > 0 && original.equals(safeFile(path.join(dist, file))), `License content mismatch: ${file}`)
  }
  check(JSON.parse(safeFile(path.join(dist, 'version.json'))).buildId === expectedBuildId, 'version.json build ID mismatch')
  const scripts = files.filter((file) => file.endsWith('.js'))
  const bodies = scripts.map((file) => safeFile(path.join(dist, file)).toString('utf8'))
  check(bodies.some((body) => body.includes(expectedBuildId)), 'Runtime build ID mismatch')
  check(bodies.every((body) => !body.includes('sourceMappingURL=')), 'Source map reference in distribution')
  const workers = ['search', 'planner', 'skillIdentification', 'gogmaCounterIdentification', 'normalArtianCounterIdentification', 'buildListOptimization']
  for (const worker of workers) check(scripts.some((file) => file.includes(`${worker}.worker.entry-`)), `Missing built Worker: ${worker}`)
  check(files.filter((file) => file.endsWith('.webp')).length === 10, 'Guide asset inventory changed; review required')
  const html = safeFile(path.join(dist, 'index.html')).toString('utf8')
  check(html.includes('/GogmaPlanner/assets/'), 'GitHub Pages base path changed')
  const textFiles = [['index.html', html], ...scripts.map((file, i) => [file, bodies[i]]), ...files.filter((file) => file.endsWith('.css')).map((file) => [file, safeFile(path.join(dist, file)).toString('utf8')])]
  for (const [file, body] of textFiles) {
    check(!body.includes('sourceMappingURL='), `Source map reference: ${file}`)
    check(!body.includes('/GogmaArtianPlanner/'), `Obsolete GitHub Pages base: ${file}`)
    const refs = [...body.matchAll(/["'`](\/GogmaPlanner\/assets\/[^"'`]+)["'`]/gu),
      ...body.matchAll(/url\(\s*["']?(\/GogmaPlanner\/assets\/[^"'()\s]+)["']?\s*\)/gu)]
    for (const match of refs) {
      const ref = match[1].slice('/GogmaPlanner/'.length).split(/[?#]/u)[0]
      check(files.includes(ref), `Missing emitted asset: ${file} -> ${ref}`)
    }
  }
  return { files: files.length, scripts: scripts.length, workers: workers.length, guideAssets: 10, buildId: expectedBuildId, licenses: ['licenses.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'], sourceMaps: 0 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args[0] === '--package-licenses') { packageLicenses(process.cwd()); args.shift() }
    check(args.length === 1, 'Usage: node scripts/verify-public-dist.mjs [--package-licenses] <Public full commit SHA>')
    process.stdout.write(JSON.stringify(verifyDist(process.cwd(), args[0]), null, 2) + '\n')
  } catch (error) { process.stderr.write(`Distribution verification failed: ${error.message}\n`); process.exitCode = 1 }
}
