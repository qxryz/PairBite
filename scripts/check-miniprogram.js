const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '..')
const miniRoot = path.join(root, 'miniprogram')
const ignored = new Set(['node_modules', 'miniprogram_npm', '.git', 'dist', 'target', 'coverage'])
const errors = []
const stats = { js: 0, json: 0, wxml: 0, bindings: 0 }

function report(file, message, offset = 0) {
  const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const line = source.slice(0, offset).split('\n').length
  errors.push(`${path.relative(root, file)}:${line}: ${message}`)
}

function filesIn(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (ignored.has(entry.name)) return []
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? filesIn(file) : entry.isFile() ? [file] : []
  })
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    report(file, `JSON 无效：${error.message}`)
    return null
  }
}

function localModule(file, request) {
  const base = path.resolve(path.dirname(file), request)
  return [base, `${base}.js`, `${base}.json`, `${base}.wxs`, path.join(base, 'index.js')]
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
}

function miniPath(file, reference) {
  return reference.startsWith('/')
    ? path.resolve(miniRoot, `.${reference}`)
    : path.resolve(path.dirname(file), reference)
}

const packageJSON = readJSON(path.join(miniRoot, 'package.json')) || {}
function npmBuildReference(target) {
  const relative = path.relative(miniRoot, target).split(path.sep).join('/')
  if (!relative.startsWith('miniprogram_npm/')) return false
  const segments = relative.slice('miniprogram_npm/'.length).split('/')
  const name = segments[0].startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  return Object.prototype.hasOwnProperty.call(packageJSON.dependencies || {}, name)
}

function resource(file, reference, offset = 0) {
  if (!reference || reference.includes('{{') || reference.includes('${') || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(reference)) return
  const target = miniPath(file, reference.split(/[?#]/)[0])
  if (!target.startsWith(`${miniRoot}${path.sep}`)) return report(file, `资源超出小程序目录：${reference}`, offset)
  // The generated npm folder is intentionally excluded; DevTools builds declared packages.
  if (!fs.existsSync(target) && !npmBuildReference(target)) report(file, `资源不存在：${reference}`, offset)
}

const appJSON = readJSON(path.join(miniRoot, 'app.json')) || {}
const routes = new Set(appJSON.pages || [])
for (const pack of appJSON.subPackages || appJSON.subpackages || []) {
  for (const page of pack.pages || []) routes.add(`${pack.root}/${page}`)
}
function route(file, reference, offset = 0) {
  if (!reference || /^(?:[a-z][\w+.-]*:|\/\/)/i.test(reference)) return
  const bare = reference.split(/[?#]/)[0]
  if (bare.includes('{{') || bare.includes('${')) return
  const resolved = path.relative(miniRoot, miniPath(file, bare)).split(path.sep).join('/')
  if (!routes.has(resolved)) report(file, `未注册的页面路由：${reference}`, offset)
}

function pageFiles(base, owner) {
  for (const extension of ['.js', '.json', '.wxml', '.wxss']) {
    if (!fs.existsSync(`${base}${extension}`)) report(owner, `页面或组件文件缺失：${path.relative(miniRoot, base)}${extension}`)
  }
}
for (const page of routes) pageFiles(path.join(miniRoot, page), path.join(miniRoot, 'app.json'))
if (routes.size !== (appJSON.pages || []).length && !(appJSON.subPackages || appJSON.subpackages)) report(path.join(miniRoot, 'app.json'), '页面路由重复')
for (const item of appJSON.tabBar?.list || []) {
  if (!routes.has(item.pagePath)) report(path.join(miniRoot, 'app.json'), `TabBar 页面未注册：${item.pagePath}`)
  resource(path.join(miniRoot, 'app.json'), item.iconPath)
  resource(path.join(miniRoot, 'app.json'), item.selectedIconPath)
}
resource(path.join(miniRoot, 'app.json'), appJSON.sitemapLocation)

// Read only the Page/Component declarations. The application bootstrap and lifecycle
// methods are never executed, so its global Page wrapper cannot affect this check.
function declaration(file) {
  let options
  const cache = new Map()
  const app = { globalData: {} }
  function load(moduleFile) {
    if (cache.has(moduleFile)) return cache.get(moduleFile).exports
    const module = { exports: {} }
    cache.set(moduleFile, module)
    if (moduleFile.endsWith('.json')) {
      module.exports = JSON.parse(fs.readFileSync(moduleFile, 'utf8'))
      return module.exports
    }
    const context = vm.createContext({
      Page: value => { options = value },
      Component: value => { options = value.methods || {} },
      getApp: () => app,
      wx: {},
      console: { log() {}, warn() {}, error() {} }
    })
    const wrapper = new vm.Script(`(function (exports, require, module) {\n${fs.readFileSync(moduleFile, 'utf8')}\n})`, { filename: moduleFile })
      .runInContext(context, { timeout: 1000 })
    wrapper(module.exports, request => {
      if (!request.startsWith('.')) throw new Error(`页面声明不应执行外部模块：${request}`)
      const target = localModule(moduleFile, request)
      if (!target || !target.startsWith(`${miniRoot}${path.sep}`)) throw new Error(`无效本地模块：${request}`)
      return load(target)
    }, module)
    return module.exports
  }
  try {
    load(file)
    if (!options) report(file, '找不到 Page 或 Component 声明')
  } catch (error) {
    report(file, `读取页面事件声明失败：${error.message}`)
  }
  return options || {}
}

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, name) => {
    if (name[0] !== '#') return named[name.toLowerCase()]
    const number = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
    return number <= 0x10ffff ? String.fromCodePoint(number) : match
  })
}

function maskExpressions(file, source) {
  const chars = source.split('')
  // Comments are not markup or expressions, and preserve offsets for diagnostics.
  for (const match of source.matchAll(/<!--[\s\S]*?-->/g)) {
    for (let i = match.index; i < match.index + match[0].length; i++) if (chars[i] !== '\n') chars[i] = ' '
  }
  const uncommented = chars.join('')
  for (let start = 0; start < source.length; start++) {
    if (uncommented.slice(start, start + 2) !== '{{') continue
    let cursor = start + 2
    let depth = 0
    let quote = ''
    for (; cursor < source.length; cursor++) {
      const char = source[cursor]
      if (quote) {
        if (char === '\\') cursor++
        else if (char === quote) quote = ''
      } else if (char === '"' || char === "'" || char === '`') quote = char
      else if (char === '{') depth++
      else if (char === '}' && depth > 0) depth--
      else if (source.slice(cursor, cursor + 2) === '}}') break
    }
    if (cursor === source.length) {
      report(file, '插值缺少结束的 }}', start)
      break
    }
    const expression = decodeEntities(source.slice(start + 2, cursor))
    try { new vm.Script(`(${expression})`, { filename: file }) }
    catch (error) { report(file, `插值表达式无效：${error.message}`, start) }
    for (let i = start; i < cursor + 2; i++) if (chars[i] !== '\n') chars[i] = ' '
    start = cursor + 1
  }
  const masked = chars.join('')
  for (const match of masked.matchAll(/}}/g)) report(file, '多余的插值结束符 }}', match.index)
  for (const match of masked.matchAll(/&(?!#\d+;|#x[\da-f]+;|amp;|lt;|gt;|quot;|apos;|nbsp;)/gi)) report(file, '文本中的 & 需要转义为 &amp;', match.index)
  return masked
}

function checkWXML(file) {
  stats.wxml++
  const source = fs.readFileSync(file, 'utf8')
  const masked = maskExpressions(file, source)
  const jsFile = file.replace(/\.wxml$/, '.js')
  const options = fs.existsSync(jsFile) ? declaration(jsFile) : {}
  const stack = [{ name: '<root>', lastConditional: '' }]
  for (let start = 0; start < masked.length; start++) {
    if (masked[start] !== '<') continue
    let end = start + 1
    let quote = ''
    for (; end < masked.length; end++) {
      const char = masked[end]
      if (quote) { if (char === quote) quote = '' }
      else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
      else if (char === '<') break
    }
    if (end === masked.length || masked[end] !== '>') {
      report(file, '标签未闭合或文本中的 < 未转义', start)
      continue
    }
    const raw = source.slice(start + 1, end)
    const tag = /^(\/)?([\w:.-]+)([\s\S]*?)(\/)?$/.exec(raw)
    if (!tag) { report(file, '标签格式无效', start); start = end; continue }
    const [, closing, name, attributeText, selfClosing] = tag
    if (closing) {
      if (attributeText.trim() || selfClosing) report(file, `结束标签格式无效：${name}`, start)
      if (stack.length === 1 || stack[stack.length - 1].name !== name) report(file, `结束标签不匹配：${name}`, start)
      else stack.pop()
      start = end
      continue
    }
    const attributes = new Map()
    const matcher = /\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/y
    let cursor = 0
    while (cursor < attributeText.length) {
      if (!attributeText.slice(cursor).trim()) break
      matcher.lastIndex = cursor
      const attr = matcher.exec(attributeText)
      if (!attr) { report(file, `属性格式无效：${attributeText.slice(cursor).trim()}`, start); break }
      if (attributes.has(attr[1])) report(file, `属性重复：${attr[1]}`, start)
      attributes.set(attr[1], attr[2] ?? attr[3] ?? null)
      cursor = matcher.lastIndex
    }
    const conditions = ['wx:if', 'wx:elif', 'wx:else'].filter(key => attributes.has(key))
    if (conditions.length > 1) report(file, '同一标签只能有一个条件指令', start)
    const conditional = conditions[0] || ''
    const parent = stack[stack.length - 1]
    if (['wx:elif', 'wx:else'].includes(conditional) && !['wx:if', 'wx:elif'].includes(parent.lastConditional)) report(file, `${conditional} 前需要相邻的 wx:if 或 wx:elif`, start)
    parent.lastConditional = conditional
    for (const [key, value] of attributes) {
      if (['wx:if', 'wx:elif', 'wx:for', 'wx:for-items'].includes(key) && (value === null || !/^\s*{{[\s\S]+}}\s*$/.test(value))) report(file, `${key} 需要 {{ }} 表达式`, start)
      // A bare wx:else is valid WXML; it does not require an expression.
      if (key === 'wx:else' && value !== null && value !== '') report(file, 'wx:else 不需要属性值', start)
      if (/^wx:for-(?:item|index)$/.test(key) && !/^[A-Za-z_$][\w$]*$/.test(value || '')) report(file, `${key} 需要有效变量名`, start)
      if (key === 'wx:key' && (!value || value.includes('{{'))) report(file, 'wx:key 需要静态字段名或 *this', start)
      if (/^(?:(?:capture-)?(?:bind|catch)|mut-bind):?[\w-]+$/.test(key) && value && !value.includes('{{')) {
        stats.bindings++
        if (typeof options[value] !== 'function') report(file, `事件处理函数不存在：${value}`, start)
      }
      if (key === 'src' || key === 'poster') resource(file, value, start)
      if (name === 'navigator' && key === 'url') route(file, value, start)
    }
    if (!selfClosing) stack.push({ name, lastConditional: '' })
    start = end
  }
  for (const element of stack.slice(1)) report(file, `标签未闭合：${element.name}`)
}

const sourceFiles = [...filesIn(miniRoot), ...filesIn(path.join(root, 'cloudfunctions')), ...filesIn(path.join(root, 'scripts')), ...filesIn(path.join(root, 'tests'))]
for (const file of sourceFiles) {
  const extension = path.extname(file)
  if (extension === '.js' || extension === '.wxs') {
    stats.js++
    const source = fs.readFileSync(file, 'utf8')
    try { new vm.Script(source, { filename: file }) }
    catch (error) { report(file, `JavaScript 语法无效：${error.message}`) }
    for (const match of source.matchAll(/\brequire\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g)) {
      if (!localModule(file, match[2])) report(file, `本地 require 不存在：${match[2]}`, match.index)
    }
    if (file.startsWith(`${miniRoot}${path.sep}`)) {
      for (const match of source.matchAll(/\burl\s*:\s*(['"`])([^'"`\n]+)\1/g)) {
        if (match[2].startsWith('/pages/') || match[2].startsWith('.')) route(file, match[2], match.index)
      }
      for (const match of source.matchAll(/(['"`])((?:\/|\.\.?\/)[^'"`\n]+\.(?:png|jpe?g|gif|webp|svg|mp3|mp4))\1/gi)) resource(file, match[2], match.index)
    }
  } else if (extension === '.json') {
    stats.json++
    const config = readJSON(file)
    if (file.startsWith(`${miniRoot}${path.sep}`)) {
      for (const [name, reference] of Object.entries(config?.usingComponents || {})) {
        if (reference.startsWith('plugin://')) continue
        const base = reference.startsWith('.') || reference.startsWith('/') ? miniPath(file, reference) : path.join(miniRoot, 'miniprogram_npm', reference)
        if (!npmBuildReference(base)) pageFiles(base, file)
        if (!name) report(file, '组件名称不能为空')
      }
    }
  } else if (extension === '.wxml') checkWXML(file)
  else if (extension === '.wxss') {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/@import\s+['"]([^'"]+)['"]/g)) resource(file, match[1], match.index)
    for (const match of source.matchAll(/url\(\s*['"]?([^\s'")]+)['"]?\s*\)/g)) resource(file, match[1], match.index)
  }
}
for (const file of ['package.json', 'project.config.json']) readJSON(path.join(root, file))
if (errors.length) {
  console.error(errors.join('\n'))
  console.error(`静态检查失败：${errors.length} 项问题。`)
  process.exitCode = 1
} else {
  console.log(`静态检查通过：${routes.size} 个页面，${stats.js} 个 JS/WXS，${stats.json} 个 JSON，${stats.wxml} 个 WXML，${stats.bindings} 个事件绑定。`)
  console.log('此检查不替代微信开发者工具编译、真机和云环境验证。')
}
