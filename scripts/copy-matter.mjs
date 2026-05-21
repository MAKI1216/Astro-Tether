import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const source = path.join(root, 'node_modules', 'matter-js', 'build', 'matter.min.js')
const targets = [
  path.join(root, 'vendor', 'matter.min.js'),
  path.join(root, 'public', 'vendor', 'matter.min.js'),
]

if (!fs.existsSync(source)) {
  console.error(`Missing Matter.js build at ${source}`)
  process.exit(1)
}

for (const target of targets) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

const configSource = path.join(root, 'game.config.js')
const configTargets = [
  path.join(root, 'public', 'game.config.js'),
]

for (const target of configTargets) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(configSource, target)
}

console.log('Copied Matter.js vendor bundle')
