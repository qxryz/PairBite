const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createDemo, STORAGE_KEY } = require('../miniprogram/utils/demo')
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

function storage() {
  const values = new Map()
  return {
    values,
    getStorageSync(key) { return clone(values.get(key)) },
    setStorageSync(key, value) { values.set(key, clone(value)) }
  }
}
function setup() {
  const wx = storage()
  const demo = createDemo(wx, { now: () => Date.parse('2026-10-15T10:00:00Z') })
  return { wx, demo, call: async (name, data) => (await demo.callFunction({ name, data })).result }
}
async function products(call) {
  return (await call('getCoupleData', { collection: 'DishList' })).data
}
function loadApp(wx, config = { envList: [{ envId: '' }], notifyTmplIds: [] }) {
  let app
  const appPath = path.resolve(__dirname, '../miniprogram/app.js')
  vm.runInNewContext(fs.readFileSync(appPath, 'utf8'), {
    wx, Page() {}, App(options) { app = options }, getApp() { return app },
    getCurrentPages() { return [] },
    require(name) { return name === './envList.js' ? config : require(path.resolve(path.dirname(appPath), name)) },
    console: { error() {}, log() {} }
  }, { filename: appPath })
  app.onLaunch()
  return app
}

test('demo seeds preserve the original collections and typed products', async () => {
  const { call } = setup()
  const { user, partner } = await call('createUser')
  assert.equal(user.bindStatus, 'bound')
  assert.equal(user.partnerId, partner._id)
  assert.equal(user.coupleId, partner.coupleId)
  const dishes = await products(call)
  assert.equal(dishes.length, 10)
  assert.ok(dishes.some(item => item.name === '芒果TV月卡'))
  assert.ok(dishes.some(item => item.name === '音乐会员'))
  assert.ok(dishes.some(item => item.type === 'gift'))
  assert.ok(dishes.every(item => !('price' in item)))
  const categories = (await call('manageCategory', { action: 'list' })).data
  assert.equal(categories.length, 10)
  assert.equal(categories.filter(item => item.type === 'food').length, 8)
  for (const dish of dishes) assert.equal(categories.find(item => item._id === dish.category).type, dish.type)
  const orders = (await call('getCoupleData', { collection: 'OrderList' })).data
  assert.equal(orders.length, 2)
  assert.ok(orders.every(item => item.isSample && item.isDemo && item.remark.startsWith('示例订单：')))
})

test('order creation is idempotent, counts once, and keeps an immutable product snapshot', async () => {
  const { call } = setup()
  const dish = (await products(call))[0]
  const input = { action: 'create', dishIds: [dish._id, dish._id], remark: '少放糖', requestId: 'test-order-1' }
  const first = await call('manageOrder', input)
  assert.equal(first.success, true)
  assert.equal(first.order.dishes.length, 1)
  assert.equal(first.order.isSample, false)
  const replay = await call('manageOrder', input)
  assert.equal(replay.orderId, first.orderId)
  assert.equal(replay.reused, true)
  assert.equal((await products(call)).find(item => item._id === dish._id).orderCount, dish.orderCount + 1)
  assert.equal((await call('manageOrder', { ...input, remark: '不同内容' })).success, false)
  assert.equal((await call('updateCoupleData', { collection: 'DishList', docId: dish._id, action: 'update', data: { name: '修改后的商品' } })).success, true)
  await call('updateCoupleData', { collection: 'DishList', docId: dish._id, action: 'remove' })
  assert.equal((await call('manageOrder', input)).orderId, first.orderId)
  const saved = await call('getCoupleData', { collection: 'OrderList', docId: first.orderId })
  assert.equal(saved.data.dishes[0].name, dish.name)
})

test('only the recipient accepts and completes; only the creator cancels pending orders', async () => {
  const { demo, call } = setup()
  const dish = (await products(call))[0]
  const create = () => call('manageOrder', { action: 'create', dishIds: [dish._id], requestId: 'permission-' + Math.random().toString(36).slice(2) })
  const first = await create()
  const update = (orderId, status) => call('manageOrder', { action: 'update', orderId, status, reply: '收到' })
  assert.equal((await update(first.orderId, 'accepted')).success, false)
  assert.equal((await update(first.orderId, 'completed')).success, false)
  demo.setIdentity('receiver')
  assert.equal((await update(first.orderId, 'cancelled')).success, false)
  assert.equal((await update(first.orderId, 'completed')).success, false)
  assert.equal((await update(first.orderId, 'accepted')).success, true)
  assert.equal((await update(first.orderId, 'accepted')).success, true)
  demo.setIdentity('requester')
  assert.equal((await update(first.orderId, 'cancelled')).success, false)
  demo.setIdentity('receiver')
  assert.equal((await update(first.orderId, 'completed')).success, true)
  assert.equal((await update(first.orderId, 'completed')).success, true)
  demo.setIdentity('requester')
  const second = await create()
  assert.equal((await update(second.orderId, 'cancelled')).success, true)
  demo.setIdentity('receiver')
  assert.equal((await update(second.orderId, 'accepted')).success, false)
})

test('custom wishes validate links, dates and submission identity', async () => {
  const { call } = setup()
  const base = { action: 'create', dishIds: [], requestId: 'wish-1', wish: { title: '想要一束花', type: 'gift', description: '粉色', link: 'https://example.com/flowers' }, expectedDate: '2026-10-20' }
  assert.equal((await call('manageOrder', { ...base, expectedDate: '2026-02-30' })).success, false)
  assert.equal((await call('manageOrder', { ...base, wish: { ...base.wish, link: 'javascript:alert(1)' } })).success, false)
  assert.equal((await call('manageOrder', { ...base, requestId: '' })).success, false)
  const result = await call('manageOrder', base)
  assert.equal(result.success, true)
  assert.equal(result.order.totalCount, 1)
  assert.equal(result.order.wish.title, base.wish.title)
  assert.equal(result.order.creatorId, 'demo-requester')
  assert.equal(result.order.recipientId, 'demo-receiver')
})

test('cross-space access and protected order fields are denied', async () => {
  const { wx, demo, call } = setup()
  const state = wx.getStorageSync(STORAGE_KEY)
  state.dishes.push({ _id: 'foreign-dish', coupleId: 'another-pair', name: '其他人的商品' })
  wx.setStorageSync(STORAGE_KEY, state)
  const foreignDemo = createDemo(wx)
  const foreignCall = async (name, data) => (await foreignDemo.callFunction({ name, data })).result
  assert.equal((await foreignCall('getCoupleData', { collection: 'DishList', docId: 'foreign-dish' })).success, false)
  assert.equal((await foreignCall('updateCoupleData', { collection: 'DishList', docId: 'foreign-dish', action: 'remove' })).success, false)
  const ownDish = (await call('getCoupleData', { collection: 'DishList' })).data[0]
  assert.equal((await call('updateCoupleData', { collection: 'DishList', docId: ownDish._id, action: 'inc', data: { orderCount: 1 } })).success, false)
  const orderId = 'demo-order-pending'
  assert.equal((await call('updateCoupleData', { collection: 'OrderList', docId: orderId, action: 'remove' })).success, false)
  assert.equal((await call('updateCoupleData', { collection: 'OrderList', docId: orderId, action: 'update', data: { status: 'completed' } })).success, false)
  assert.equal((await call('updateCoupleData', { collection: 'OrderList', docId: orderId, action: 'update', data: { finishedPhoto: '/saved/a.jpg' } })).success, false)
  demo.setIdentity('receiver')
  assert.equal((await call('updateCoupleData', { collection: 'OrderList', docId: orderId, action: 'update', data: { finishedPhoto: '/saved/a.jpg' } })).success, true)
})

test('category removal preserves each type and rejects cross-type transfers atomically', async () => {
  const { call } = setup()
  const categories = (await call('manageCategory', { action: 'list' })).data
  const membership = categories.find(item => item.type === 'membership')
  const food = categories.find(item => item.type === 'food')
  const remove = data => call('manageCategory', { action: 'remove', data })
  assert.equal((await remove({ _id: membership._id })).success, false)
  const extra = await call('manageCategory', { action: 'add', data: { name: '其他会员', icon: '🎟️', type: 'membership' } })
  assert.equal(extra.success, true)
  assert.equal((await remove({ _id: membership._id, transferTo: food._id })).success, false)
  assert.ok((await products(call)).filter(item => item.type === 'membership').every(item => item.category === membership._id))
  assert.equal((await remove({ _id: membership._id, transferTo: extra._id })).success, true)
  assert.ok((await products(call)).filter(item => item.type === 'membership').every(item => item.category === extra._id))
  const before = (await call('manageCategory', { action: 'list' })).data
  const result = await call('manageCategory', { action: 'reorder', data: { orders: [{ _id: food._id, sort: 50 }, { _id: 'foreign-category', sort: 1 }] } })
  assert.equal(result.success, false)
  assert.deepEqual((await call('manageCategory', { action: 'list' })).data, before)
})

test('catalog writes keep trusted metadata and persist across identity changes', async () => {
  const { wx, demo, call } = setup()
  const category = (await call('manageCategory', { action: 'list' })).data.find(item => item.type === 'membership')
  const added = await call('updateCoupleData', { collection: 'DishList', action: 'add', data: { name: '测试会员', type: 'membership', category: category._id, spec: '月卡', coupleId: 'forged', _openid: 'forged' } })
  assert.equal(added.success, true)
  const doc = (await call('getCoupleData', { collection: 'DishList', docId: added._id })).data
  assert.equal(doc.spec, '月卡')
  assert.equal(doc._openid, 'demo-requester')
  assert.notEqual(doc.coupleId, 'forged')
  assert.ok(!Number.isNaN(Date.parse(doc.createTime)))
  await call('updateCoupleData', { collection: 'DishList', docId: added._id, action: 'update', data: { name: '已更新会员' } })
  demo.setIdentity('receiver')
  const reloaded = createDemo(wx)
  assert.equal(reloaded.getIdentity(), 'receiver')
  assert.equal((await reloaded.callFunction({ name: 'createUser' })).result.user._id, 'demo-receiver')
  const result = await reloaded.callFunction({ name: 'getCoupleData', data: { collection: 'DishList', docId: added._id } })
  assert.equal(result.result.data.name, '已更新会员')
})

test('failed persistence rolls back mutation and does not make later reads fail', async () => {
  const { wx, call } = setup()
  const before = await products(call)
  wx.setStorageSync = () => { throw new Error('本机存储空间不足') }
  const result = await call('updateCoupleData', { collection: 'DishList', action: 'add', data: { name: '未保存商品', category: before[0].category, type: before[0].type } })
  assert.equal(result.success, false)
  assert.match(result.message, /存储/)
  assert.equal((await products(call)).length, before.length)
})

test('app demo supports session switching, native callback shape and persistent local photos', async () => {
  const wx = storage()
  let cloudCalls = 0
  wx.cloud = { init() { cloudCalls++ }, callFunction() { cloudCalls++ } }
  wx.saveFile = options => options.success({ savedFilePath: '/saved/photo.jpg' })
  const app = loadApp(wx)
  assert.equal(app.globalData.isDemo, true)
  const firstLoad = app.loadUserInfo()
  const switchLoad = app.setDemoIdentity('receiver')
  await Promise.all([firstLoad, switchLoad])
  assert.equal(app.globalData.currentUser._id, 'demo-receiver')
  assert.equal(app.getDemoIdentity(), 'receiver')
  assert.equal(app.globalData.categories.length, 10)
  let successes = 0
  let completes = 0
  await app.callFunction({ name: 'getOpenId', success() { successes++ }, complete() { completes++ } })
  assert.equal(successes, 1)
  assert.equal(completes, 1)
  const upload = await app.uploadFile({ filePath: '/tmp/photo.jpg', cloudPath: 'pictures/photo.jpg' })
  assert.equal(upload.fileID, '/saved/photo.jpg')
  assert.equal(cloudCalls, 0)
})

test('subscription skipping always completes navigation and never claims acceptance', async () => {
  const wx = storage()
  wx.requestSubscribeMessage = () => { throw new Error('should not prompt') }
  const app = loadApp(wx)
  let completed = 0
  let accepted = false
  const skipped = await app.requestSubscribeMessage({ tmplIds: ['your-template-id'], success() { accepted = true }, complete(result) { completed++; assert.equal(result.skipped, true) } })
  assert.equal(skipped.reason, 'demo')
  assert.equal(completed, 1)
  assert.equal(accepted, false)
  const cloudApp = loadApp({ ...storage(), cloud: { init() {} }, requestSubscribeMessage: wx.requestSubscribeMessage }, { envList: [{ envId: 'real-env' }], notifyTmplIds: ['your-template-id'] })
  const unconfigured = await cloudApp.requestSubscribeMessage({ complete() { completed++ } })
  assert.equal(unconfigured.reason, 'not-configured')
  assert.equal(completed, 2)
})

test('configured cloud delegates and never falls back when cloud calls fail', async () => {
  const wx = storage()
  let initialized
  wx.cloud = {
    init(options) { initialized = options.env },
    callFunction() { return Promise.reject(new Error('云连接失败')) },
    uploadFile(options) { return Promise.resolve({ fileID: 'cloud://' + options.cloudPath }) },
    deleteFile(options) { return Promise.resolve({ fileList: options.fileList }) }
  }
  const app = loadApp(wx, { envList: [{ envId: 'live-env' }], notifyTmplIds: [] })
  assert.equal(initialized, 'live-env')
  assert.equal(app.globalData.isDemo, false)
  await assert.rejects(app.callFunction({ name: 'createUser' }), /云连接失败/)
  assert.equal((await app.uploadFile({ cloudPath: 'pictures/a.jpg' })).fileID, 'cloud://pictures/a.jpg')
  assert.equal(app.getDemoIdentity(), null)
  await assert.rejects(app.setDemoIdentity('receiver'), /仅本地体验/)
  assert.equal(wx.values.has(STORAGE_KEY), false)
})

test('configured cloud initialization failures remain visible instead of activating demo', () => {
  const wx = storage()
  wx.cloud = { init() { throw new Error('环境不存在') } }
  const app = loadApp(wx, { envList: [{ envId: 'missing-env' }], notifyTmplIds: [] })
  assert.equal(app.globalData.isDemo, false)
  assert.throws(() => app.callFunction({ name: 'createUser' }), /环境不存在/)
  assert.equal(wx.values.has(STORAGE_KEY), false)
})
