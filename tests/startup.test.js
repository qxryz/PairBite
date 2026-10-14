const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createDemo, STORAGE_KEY } = require('../miniprogram/utils/demo')

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const quietConsole = { error() {}, log() {} }

function storage() {
  return {
    values: new Map(),
    writes: 0,
    getStorageSync(key) {
      if (this.readError) throw this.readError
      return clone(this.values.get(key))
    },
    setStorageSync(key, value) {
      this.writes++
      if (this.writeError) throw this.writeError
      this.values.set(key, clone(value))
    },
    setNavigationBarTitle(options) { this.title = options.title }
  }
}

function loadApp(wx, envId = '') {
  let app
  const appPath = path.resolve(__dirname, '../miniprogram/app.js')
  vm.runInNewContext(fs.readFileSync(appPath, 'utf8'), {
    wx, Page() {}, App(options) { app = options }, getApp() { return app },
    getCurrentPages() { return [] }, console: quietConsole,
    require(name) {
      return name === './envList.js'
        ? { envList: [{ envId }], notifyTmplIds: [] }
        : require(path.resolve(path.dirname(appPath), name))
    }
  }, { filename: appPath })
  const launchResult = app.onLaunch()
  return { app, launchResult }
}

function loadPage(name, app, wx) {
  let page
  const pagePath = path.resolve(__dirname, '../miniprogram/pages', name, 'index.js')
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), {
    wx, getApp() { return app }, Page(options) { page = options }, console: quietConsole
  }, { filename: pagePath })
  page.data = clone(page.data)
  page.setData = values => Object.assign(page.data, values)
  return page
}

test('storage read failure is handled at launch and does not break read-only Settings state', async () => {
  const wx = storage()
  const error = new Error('getStorageSync:fail access denied')
  wx.readError = error
  const { app, launchResult } = loadApp(wx)
  assert.equal(launchResult, undefined)
  assert.match(app.globalData.startupError, /存储.*重试/)
  assert.equal(app.globalData.isDemo, true)
  assert.equal(wx.writes, 0)
  assert.throws(() => app.callFunction({ name: 'createUser' }), thrown => thrown === error)
  assert.throws(() => app.uploadFile({ filePath: '/tmp/photo.jpg' }), thrown => thrown === error)
  assert.throws(() => app.deleteFile({ fileList: [] }), thrown => thrown === error)
  await assert.rejects(app.setDemoIdentity('receiver'), thrown => thrown === error)
  assert.equal(app.getDemoIdentity(), null)
  assert.equal(app.isBound(), false)

  const settings = loadPage('Settings', app, wx)
  await settings.onShow()
  assert.equal(settings.data.demoIdentity, null)
  assert.equal(settings.data.isBound, false)
  assert.equal(wx.title, app.globalData.appName)
})

test('first storage write failure stays unavailable until a homepage retry succeeds', async () => {
  const wx = storage()
  const error = new Error('setStorageSync:fail quota exceeded')
  wx.writeError = error
  const { app } = loadApp(wx)
  assert.equal(wx.values.has(STORAGE_KEY), false)
  assert.throws(() => app.callFunction({ name: 'createUser' }), thrown => thrown === error)
  const home = loadPage('MainPage', app, wx)
  await home.onShow()
  assert.equal(home.data.pageLoading, false)
  assert.match(home.data.startupError, /存储/)
  assert.equal(home.hasLoaded, false)

  await home.retryStartup()
  assert.equal(home.data.pageLoading, false)
  assert.match(home.data.startupError, /存储/)
  assert.equal(wx.values.has(STORAGE_KEY), false)

  wx.writeError = null
  await home.retryStartup()
  assert.equal(home.data.pageLoading, false)
  assert.equal(home.data.startupError, '')
  assert.equal(home.hasLoaded, true)
  assert.equal(home.data.isBound, true)
  assert.equal(home.data.dishCount, 10)
  assert.equal(app.getDemoIdentity(), 'requester')
  assert.equal(app.globalData.startupError, '')
  assert.equal(wx.values.has(STORAGE_KEY), true)
})

test('retry after a read failure preserves valid saved data and identity without rewriting it', async () => {
  const wx = storage()
  const savedDemo = createDemo(wx)
  await savedDemo.callFunction({ name: 'createUser', data: { nickname: '保存的昵称' } })
  await savedDemo.callFunction({ name: 'updateKitchenName', data: { kitchenName: '我的小店' } })
  savedDemo.setIdentity('receiver')
  const saved = clone(wx.values.get(STORAGE_KEY))
  wx.writes = 0
  wx.readError = new Error('读取失败')
  const { app } = loadApp(wx)
  assert.equal(app.getDemoIdentity(), null)

  wx.readError = null
  assert.equal(app.initcloud(), true)
  assert.equal(app.getDemoIdentity(), 'receiver')
  assert.equal(wx.writes, 0)
  assert.deepEqual(wx.values.get(STORAGE_KEY), saved)
  const { currentUser, partner } = await app.loadUserInfo()
  assert.equal(currentUser._id, 'demo-receiver')
  assert.equal(currentUser.kitchenName, '我的小店')
  assert.equal(partner.nickname, '保存的昵称')
  assert.equal(wx.writes, 0)
  assert.deepEqual(wx.values.get(STORAGE_KEY), saved)
})

test('cloud initialization failure remains in cloud mode and can be retried without local data', async () => {
  const wx = storage()
  const error = new Error('环境不存在')
  let unavailable = true
  let cloudCalls = 0
  wx.cloud = {
    init() { if (unavailable) throw error },
    callFunction() { cloudCalls++; return Promise.resolve({ result: { success: true } }) }
  }
  const { app, launchResult } = loadApp(wx, 'configured-env')
  assert.equal(launchResult, undefined)
  assert.equal(app.globalData.isDemo, false)
  assert.equal(app._cloudError, error)
  assert.match(app.globalData.startupError, /连接.*重试/)
  assert.throws(() => app.callFunction({ name: 'createUser' }), thrown => thrown === error)
  assert.throws(() => app.cloud(), thrown => thrown === error)
  assert.equal(app.getDemoIdentity(), null)
  assert.equal(wx.values.has(STORAGE_KEY), false)
  assert.equal(wx.writes, 0)

  unavailable = false
  assert.equal(app.initcloud(), true)
  assert.equal(app.globalData.startupError, '')
  assert.equal(app._cloudError, null)
  await app.callFunction({ name: 'createUser' })
  assert.equal(cloudCalls, 1)
  assert.equal(app.globalData.isDemo, false)
  assert.equal(wx.values.has(STORAGE_KEY), false)
})
