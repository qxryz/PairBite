const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const { AsyncLocalStorage } = require('node:async_hooks')

const clone = value => structuredClone(value)
const FUNCTION_NAMES = ['manageOrder', 'getCoupleData', 'updateCoupleData', 'bindPartner', 'unbindPartner', 'manageCategory', 'sendNotify', 'updateKitchenName']
const TEMPLATE_ENV = ['NOTIFY_TEMPLATE_ID', 'ORDER_STATUS_TEMPLATE_ID', 'NOTIFY_TEMPLATE_FIELDS', 'ORDER_STATUS_TEMPLATE_FIELDS']

// Each harness owns its SDK and database. Serial transactions commit a private
// snapshot, so a failed callback discards every write and competing binds reread.
function harness(seed = {}, options = {}) {
  const context = new AsyncLocalStorage()
  const store = new Map()
  const state = { notifications: [], calls: [], beforeWrite: null, callFunctionError: null }
  for (const name of ['User', 'DishList', 'OrderList', 'Category']) {
    store.set(name, new Map((seed[name] || []).map(row => [row._id, clone(row)])))
  }
  let nextId = 0
  let transactionTail = Promise.resolve()
  const command = {
    inc: value => ({ operation: 'inc', value }),
    gte: value => ({ operation: 'gte', value })
  }
  const documents = (database, name) => {
    if (!database.has(name)) database.set(name, new Map())
    return database.get(name)
  }
  const compare = (actual, expected) => expected && expected.operation === 'gte'
    ? actual >= expected.value
    : actual === expected
  const write = (name, id, operation) => {
    if (state.beforeWrite) state.beforeWrite({ collection: name, id, operation })
  }
  function collection(database, name, query = {}) {
    return {
      doc(id) {
        return {
          async get() { return { data: clone(documents(database, name).get(id) || null) } },
          async set({ data }) {
            write(name, id, 'set')
            assert.equal(Object.hasOwn(data, '_id'), false, 'doc.set must take its ID from the reference')
            documents(database, name).set(id, { ...clone(data), _id: id })
            return { _id: id, stats: { created: 1, updated: 0 } }
          },
          async update({ data }) {
            write(name, id, 'update')
            const rows = documents(database, name)
            const current = rows.get(id)
            if (!current) throw new Error('document does not exist')
            for (const [key, value] of Object.entries(data)) {
              current[key] = value && value.operation === 'inc'
                ? (current[key] || 0) + value.value
                : clone(value)
            }
            return { stats: { updated: 1 } }
          },
          async remove() {
            write(name, id, 'remove')
            return { stats: { removed: Number(documents(database, name).delete(id)) } }
          }
        }
      },
      where(condition) { return collection(database, name, { ...query, condition: { ...query.condition, ...condition } }) },
      orderBy(field, direction) { return collection(database, name, { ...query, field, direction }) },
      limit(limit) { return collection(database, name, { ...query, limit }) },
      skip(skip) { return collection(database, name, { ...query, skip }) },
      async add({ data }) {
        const id = `generated_${++nextId}`
        write(name, id, 'add')
        documents(database, name).set(id, { ...clone(data), _id: id })
        return { _id: id }
      },
      async get() {
        let rows = [...documents(database, name).values()].filter(row => Object.entries(query.condition || {}).every(([key, value]) => compare(row[key], value)))
        if (query.field) rows.sort((left, right) => (left[query.field] > right[query.field] ? 1 : left[query.field] < right[query.field] ? -1 : 0) * (query.direction === 'desc' ? -1 : 1))
        rows = rows.slice(query.skip || 0, query.limit === undefined ? undefined : (query.skip || 0) + query.limit)
        return { data: clone(rows) }
      },
      async count() {
        const rows = [...documents(database, name).values()].filter(row => Object.entries(query.condition || {}).every(([key, value]) => compare(row[key], value)))
        return { total: rows.length }
      }
    }
  }
  const database = {
    command,
    collection: name => collection(store, name),
    serverDate: () => new Date('2026-10-15T01:02:03.000Z'),
    async runTransaction(callback) {
      const previous = transactionTail
      let release
      transactionTail = new Promise(resolve => { release = resolve })
      await previous
      const snapshot = clone(store)
      try {
        const result = await callback({ collection: name => collection(snapshot, name) })
        store.clear()
        for (const [name, rows] of snapshot) store.set(name, rows)
        return options.transactionEnvelope ? { result } : result
      } finally {
        release()
      }
    }
  }
  const sdk = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    database: () => database,
    getWXContext: () => ({ OPENID: context.getStore() || '' }),
    async callFunction(input) {
      state.calls.push(clone(input))
      if (state.callFunctionError) throw state.callFunctionError
      return { result: { success: true } }
    },
    openapi: { subscribeMessage: { async send(input) { state.notifications.push(clone(input)); return { errCode: 0 } } } }
  }
  const functions = {}
  const originalLoad = Module._load
  try {
    Module._load = function (request, parent, isMain) {
      return request === 'wx-server-sdk' ? sdk : originalLoad.call(this, request, parent, isMain)
    }
    for (const name of FUNCTION_NAMES) {
      const filename = path.resolve(__dirname, '..', 'cloudfunctions', name, 'index.js')
      delete require.cache[filename]
      functions[name] = require(filename).main
    }
  } finally {
    Module._load = originalLoad
  }
  return {
    state,
    invoke: (name, openid, event) => context.run(openid, () => functions[name](event)),
    read: (name, id) => clone(documents(store, name).get(id) || null),
    rows: name => clone([...documents(store, name).values()])
  }
}

function pairSeed(extra = {}) {
  return {
    User: [
      { _id: 'alice', inviteCode: 'ALICE1', partnerId: 'bob', bindStatus: 'bound', coupleId: 'alice_bob', kitchenName: '两人菜单' },
      { _id: 'bob', inviteCode: 'BOB001', partnerId: 'alice', bindStatus: 'bound', coupleId: 'alice_bob' },
      { _id: 'carol', partnerId: 'dave', bindStatus: 'bound', coupleId: 'carol_dave' },
      { _id: 'dave', partnerId: 'carol', bindStatus: 'bound', coupleId: 'carol_dave' }
    ],
    Category: [
      { _id: 'food', coupleId: 'alice_bob', name: '家常菜', icon: '🍲', type: 'food', sort: 0 },
      { _id: 'food2', coupleId: 'alice_bob', name: '其他菜', icon: '🥬', type: 'food', sort: 1 },
      { _id: 'gift', coupleId: 'alice_bob', name: '礼物', icon: '🎁', type: 'gift', sort: 2 },
      { _id: 'foreignCategory', coupleId: 'carol_dave', name: '他人菜单', icon: '🍲', type: 'food', sort: 0 }
    ],
    DishList: [
      { _id: 'dish1', coupleId: 'alice_bob', _openid: 'bob', name: '面条', imageUrl: 'cloud://noodles', category: 'food', type: 'food', description: '清汤', spec: '一份', ingredients: 'private recipe', orderCount: 2 },
      { _id: 'foreignDish', coupleId: 'carol_dave', _openid: 'carol', name: '他人商品', category: 'foreignCategory', orderCount: 7 }
    ],
    ...extra
  }
}

const createInput = overrides => ({ action: 'create', dishIds: ['dish1'], requestId: 'request_1', ...overrides })
const pendingOrder = overrides => ({ _id: 'order1', coupleId: 'alice_bob', _openid: 'alice', creatorId: 'alice', recipientId: 'bob', status: 'pending', dishes: [{ _id: 'dish1', name: '面条' }], ...overrides })

test('getCoupleData isolates lists, document reads, counts, and query fields', async () => {
  const h = harness(pairSeed())
  const list = await h.invoke('getCoupleData', 'alice', { collection: 'DishList' })
  assert.equal(list.success, true)
  assert.deepEqual(list.data.map(row => row._id), ['dish1'])
  assert.equal((await h.invoke('getCoupleData', 'alice', { collection: 'DishList', countOnly: true })).total, 1)
  assert.equal((await h.invoke('getCoupleData', 'alice', { collection: 'DishList', docId: 'foreignDish' })).success, false)
  for (const query of [{ collection: 'User' }, { collection: 'DishList', orderBy: 'coupleId' }, { collection: 'DishList', limit: 101 }, { collection: 'DishList', skip: -1 }]) {
    assert.equal((await h.invoke('getCoupleData', 'alice', query)).success, false)
  }
})

test('getCoupleData uses the UTC+8 day boundary and pagination', async () => {
  const now = Date.now()
  const start = Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000
  const h = harness(pairSeed({ OrderList: [
    pendingOrder({ _id: 'old', createTime: new Date(start - 1) }),
    pendingOrder({ _id: 'today1', createTime: new Date(start) }),
    pendingOrder({ _id: 'today2', createTime: new Date(start + 1) }),
    pendingOrder({ _id: 'foreign', coupleId: 'carol_dave', createTime: new Date(start + 2) })
  ] }))
  assert.equal((await h.invoke('getCoupleData', 'alice', { collection: 'OrderList', todayOnly: true, countOnly: true })).total, 2)
  const page = await h.invoke('getCoupleData', 'alice', { collection: 'OrderList', todayOnly: true, order: 'asc', skip: 1, limit: 1 })
  assert.deepEqual(page.data.map(row => row._id), ['today2'])
  assert.equal((await h.invoke('getCoupleData', '', { collection: 'OrderList' })).success, false)
})

test('updateCoupleData protects dish ownership fields and validates categories', async () => {
  const h = harness(pairSeed())
  const directCount = await h.invoke('updateCoupleData', 'alice', { collection: 'DishList', action: 'inc', docId: 'dish1', data: { orderCount: 10 } })
  assert.equal(directCount.success, false)
  assert.equal(h.read('DishList', 'dish1').orderCount, 2)
  assert.equal(h.rows('OrderList').length, 0)
  for (const key of ['coupleId', '_openid', '_id', 'orderCount']) {
    const result = await h.invoke('updateCoupleData', 'alice', { collection: 'DishList', action: 'update', docId: 'dish1', data: { [key]: 'forged' } })
    assert.equal(result.success, false, key)
  }
  for (const category of ['foreignCategory', 'missing', 'gift']) {
    const result = await h.invoke('updateCoupleData', 'alice', { collection: 'DishList', action: 'add', data: { name: '新增', category, type: 'food' } })
    assert.equal(result.success, false, category)
  }
  const added = await h.invoke('updateCoupleData', 'alice', { collection: 'DishList', action: 'add', data: { name: '  米饭  ', category: 'food', spec: '一碗' } })
  assert.equal(added.success, true)
  assert.deepEqual({ name: h.read('DishList', added._id).name, coupleId: h.read('DishList', added._id).coupleId, owner: h.read('DishList', added._id)._openid }, { name: '米饭', coupleId: 'alice_bob', owner: 'alice' })
})

test('updateCoupleData rejects cross-space mutations and order status bypass', async () => {
  const h = harness(pairSeed({ OrderList: [pendingOrder(), pendingOrder({ _id: 'foreignOrder', coupleId: 'carol_dave' })] }))
  for (const action of ['update', 'remove', 'inc']) {
    const data = action === 'inc' ? { orderCount: 1 } : { name: 'forged' }
    assert.equal((await h.invoke('updateCoupleData', 'alice', { collection: 'DishList', action, docId: 'foreignDish', data })).success, false)
  }
  for (const data of [{ status: 'completed' }, { coupleId: 'carol_dave' }, { _openid: 'bob' }]) {
    assert.equal((await h.invoke('updateCoupleData', 'alice', { collection: 'OrderList', action: 'update', docId: 'order1', data })).success, false)
  }
  assert.equal((await h.invoke('updateCoupleData', 'alice', { collection: 'OrderList', action: 'remove', docId: 'order1' })).success, false)
  assert.equal((await h.invoke('updateCoupleData', 'alice', { collection: 'OrderList', action: 'update', docId: 'foreignOrder', data: { marked: true } })).success, false)
  assert.equal(h.read('DishList', 'foreignDish').orderCount, 7)
  assert.equal(h.read('OrderList', 'order1').status, 'pending')
})

test('order photos require the recipient while marking remains available to the pair', async () => {
  const h = harness(pairSeed({ OrderList: [pendingOrder()] }))
  const input = { collection: 'OrderList', action: 'update', docId: 'order1', data: { finishedPhoto: 'cloud://finished' } }
  assert.equal((await h.invoke('updateCoupleData', 'alice', input)).success, false)
  assert.equal((await h.invoke('updateCoupleData', 'bob', input)).success, true)
  assert.equal((await h.invoke('updateCoupleData', 'alice', { ...input, data: { marked: true } })).success, true)
  assert.equal(h.read('OrderList', 'order1').finishedPhoto, 'cloud://finished')
})

test('creating an order stores trusted snapshots, deduplicates dishes, and increments once', async () => {
  const h = harness(pairSeed())
  const input = createInput({ dishIds: ['dish1', 'dish1'], wish: { title: '  买本书  ', type: 'gift', link: 'https://example.com/book' }, remark: '周末', expectedDate: '2026-10-20', coupleId: 'forged', _openid: 'carol' })
  const created = await h.invoke('manageOrder', 'alice', input)
  assert.equal(created.success, true)
  const order = h.read('OrderList', created.orderId)
  assert.equal(order._openid, 'alice')
  assert.equal(order.creatorId, 'alice')
  assert.equal(order.recipientId, 'bob')
  assert.equal(order.coupleId, 'alice_bob')
  assert.equal(order.totalCount, 2)
  assert.equal(order.dishes.length, 1)
  assert.equal(order.dishes[0].name, '面条')
  assert.equal(order.dishes[0].spec, '一份')
  assert.equal('ingredients' in order.dishes[0], false)
  assert.equal(order.wish.title, '买本书')
  assert.equal(h.read('DishList', 'dish1').orderCount, 3)
  await h.invoke('updateCoupleData', 'bob', { collection: 'DishList', action: 'update', docId: 'dish1', data: { name: '改名后的面条' } })
  assert.equal(h.read('OrderList', created.orderId).dishes[0].name, '面条')
})

test('concurrent create retries reuse one order and reject requestId payload changes', async () => {
  const h = harness(pairSeed())
  const input = createInput()
  const results = await Promise.all([h.invoke('manageOrder', 'alice', input), h.invoke('manageOrder', 'alice', input)])
  assert.equal(results.every(result => result.success), true)
  assert.equal(new Set(results.map(result => result.orderId)).size, 1)
  assert.deepEqual(results.map(result => result.reused).sort(), [false, true])
  assert.equal(h.rows('OrderList').length, 1)
  assert.equal(h.read('DishList', 'dish1').orderCount, 3)
  assert.equal(h.state.calls.length, 1)
  const changed = await h.invoke('manageOrder', 'alice', createInput({ remark: 'changed' }))
  assert.equal(changed.success, false)
  assert.match(changed.message, /请求编号/)
  assert.equal(h.rows('OrderList').length, 1)
})

test('order creation rejects cross-space dishes, invalid wishes, and invalid dates without writes', async () => {
  const h = harness(pairSeed())
  for (const input of [
    createInput({ dishIds: ['dish1', 'foreignDish'] }),
    createInput({ dishIds: ['missing'] }),
    createInput({ dishIds: [], wish: { title: '礼物', link: 'javascript:alert(1)' } }),
    createInput({ expectedDate: '2026-02-30' }),
    createInput({ dishIds: [] })
  ]) assert.equal((await h.invoke('manageOrder', 'alice', input)).success, false)
  assert.equal(h.rows('OrderList').length, 0)
  assert.equal(h.read('DishList', 'dish1').orderCount, 2)
  const wishOnly = await h.invoke('manageOrder', 'alice', createInput({ dishIds: [], wish: { title: '一起旅行', type: 'other' } }))
  assert.equal(wishOnly.success, true)
  assert.equal(wishOnly.order.totalCount, 1)
})

test('order state transitions enforce the creator and recipient roles and terminal states', async () => {
  const h = harness(pairSeed({ OrderList: [pendingOrder()] }))
  const update = (openid, status, extra = {}) => h.invoke('manageOrder', openid, { action: 'update', orderId: 'order1', status, ...extra })
  assert.equal((await update('alice', 'accepted')).success, false)
  assert.equal((await update('bob', 'cancelled')).success, false)
  assert.equal((await update('bob', 'completed')).success, false)
  assert.equal((await update('bob', 'accepted', { reply: '今天做' })).success, true)
  assert.equal((await update('bob', 'accepted')).success, true)
  assert.equal(h.state.calls.length, 1, 'repeating a state must not notify again')
  assert.equal(h.read('OrderList', 'order1').reply, '今天做')
  assert.equal((await update('bob', 'completed')).success, true)
  assert.equal((await update('alice', 'cancelled')).success, false)
  assert.equal((await update('bob', 'accepted')).success, false)
  assert.equal(h.read('OrderList', 'order1').status, 'completed')
})

test('legacy orders without status or explicit participants behave as pending orders', async () => {
  const legacy = pendingOrder({ status: undefined, creatorId: undefined, recipientId: undefined })
  const h = harness(pairSeed({ OrderList: [legacy, { ...legacy, _id: 'legacyCancel' }] }))
  const accepted = await h.invoke('manageOrder', 'bob', { action: 'update', orderId: 'order1', status: 'accepted' })
  assert.equal(accepted.success, true)
  assert.equal(h.read('OrderList', 'order1').creatorId, 'alice')
  assert.equal(h.read('OrderList', 'order1').recipientId, 'bob')
  assert.equal((await h.invoke('manageOrder', 'alice', { action: 'update', orderId: 'legacyCancel', status: 'cancelled' })).success, true)
  assert.equal((await h.invoke('manageOrder', 'bob', { action: 'update', orderId: 'legacyCancel', status: 'accepted' })).success, false)
})

test('order updates reject foreign-space orders and forged old participants', async () => {
  const h = harness(pairSeed({ OrderList: [pendingOrder({ _id: 'foreignOrder', coupleId: 'carol_dave' }), pendingOrder({ _id: 'forgedOrder', creatorId: 'carol' }), pendingOrder({ _id: 'forgedRecipient', recipientId: 'dave' })] }))
  for (const orderId of ['foreignOrder', 'forgedOrder', 'forgedRecipient']) {
    assert.equal((await h.invoke('manageOrder', 'bob', { action: 'update', orderId, status: 'accepted' })).success, false)
  }
})

test('partial transaction failures roll back the order and dish counters', async () => {
  const seed = pairSeed()
  seed.DishList.push({ ...seed.DishList[0], _id: 'dish2', orderCount: 4 })
  const h = harness(seed)
  h.state.beforeWrite = ({ collection, id }) => { if (collection === 'DishList' && id === 'dish2') throw new Error('simulated second counter failure') }
  assert.equal((await h.invoke('manageOrder', 'alice', createInput({ dishIds: ['dish1', 'dish2'] }))).success, false)
  assert.equal(h.rows('OrderList').length, 0)
  assert.equal(h.read('DishList', 'dish1').orderCount, 2)
  assert.equal(h.read('DishList', 'dish2').orderCount, 4)
  assert.equal(h.state.calls.length, 0)
})

test('a broken reciprocal pair cannot create an order or update its status', async () => {
  const seed = pairSeed({ OrderList: [pendingOrder()] })
  seed.User.find(user => user._id === 'bob').partnerId = 'carol'
  const h = harness(seed)
  assert.equal((await h.invoke('manageOrder', 'alice', createInput())).success, false)
  assert.equal((await h.invoke('manageOrder', 'alice', { action: 'update', orderId: 'order1', status: 'cancelled' })).success, false)
  assert.equal(h.rows('OrderList').length, 1)
  assert.equal(h.read('OrderList', 'order1').status, 'pending')
  assert.equal(h.read('DishList', 'dish1').orderCount, 2)
  assert.equal(h.state.calls.length, 0)
})

test('notification invocation failure leaves the committed order, counters, and state intact', async () => {
  const h = harness(pairSeed())
  h.state.callFunctionError = new Error('simulated notification service unavailable')
  const created = await h.invoke('manageOrder', 'alice', createInput())
  assert.equal(created.success, true)
  assert.equal(h.read('OrderList', created.orderId).status, 'pending')
  assert.equal(h.read('DishList', 'dish1').orderCount, 3)
  assert.equal((await h.invoke('manageOrder', 'alice', createInput())).reused, true)
  assert.equal(h.state.calls.length, 1)
  const input = { action: 'update', orderId: created.orderId, status: 'accepted' }
  assert.equal((await h.invoke('manageOrder', 'bob', input)).success, true)
  assert.equal((await h.invoke('manageOrder', 'bob', input)).success, true)
  assert.equal(h.read('OrderList', created.orderId).status, 'accepted')
  assert.equal(h.state.calls.length, 2)
  assert.equal(h.read('DishList', 'dish1').orderCount, 3)
})

test('three concurrent bind attempts leave exactly one reciprocal pair', async () => {
  const h = harness({ User: [
    { _id: 'alice', inviteCode: 'ALICE1', bindStatus: 'unbound', partnerId: '' },
    { _id: 'bob', inviteCode: 'BOB001', bindStatus: 'unbound', partnerId: '' },
    { _id: 'carol', inviteCode: 'CAROL1', bindStatus: 'unbound', partnerId: '' }
  ] })
  const results = await Promise.all([
    h.invoke('bindPartner', 'alice', { inviteCode: 'bob001' }),
    h.invoke('bindPartner', 'carol', { inviteCode: 'BOB001' }),
    h.invoke('bindPartner', 'bob', { inviteCode: 'CAROL1' })
  ])
  assert.equal(results.filter(result => result.success).length, 1)
  const bound = h.rows('User').filter(user => user.bindStatus === 'bound')
  assert.equal(bound.length, 2)
  for (const user of bound) {
    const partner = h.read('User', user.partnerId)
    assert.equal(partner.partnerId, user._id)
    assert.equal(partner.coupleId, user.coupleId)
  }
})

test('binding rolls both users back when the second write fails', async () => {
  const h = harness({ User: [
    { _id: 'alice', inviteCode: 'ALICE1', bindStatus: 'unbound', partnerId: '' },
    { _id: 'bob', inviteCode: 'BOB001', bindStatus: 'unbound', partnerId: '' }
  ] })
  h.state.beforeWrite = ({ id }) => { if (id === 'bob') throw new Error('simulated partner update failure') }
  assert.equal((await h.invoke('bindPartner', 'alice', { inviteCode: 'BOB001' })).success, false)
  assert.equal(h.read('User', 'alice').bindStatus, 'unbound')
  assert.equal(h.read('User', 'bob').bindStatus, 'unbound')
})

test('unbind is reciprocal and does not clear an unrelated replacement relationship', async () => {
  const h = harness(pairSeed())
  assert.equal((await h.invoke('unbindPartner', 'alice')).success, true)
  for (const id of ['alice', 'bob']) {
    assert.equal(h.read('User', id).partnerId, '')
    assert.equal(h.read('User', id).coupleId, '')
    assert.equal(h.read('User', id).bindStatus, 'unbound')
  }
  const stale = harness({ User: [
    { _id: 'alice', partnerId: 'bob', bindStatus: 'bound', coupleId: 'alice_bob' },
    { _id: 'bob', partnerId: 'carol', bindStatus: 'bound', coupleId: 'bob_carol' },
    { _id: 'carol', partnerId: 'bob', bindStatus: 'bound', coupleId: 'bob_carol' }
  ] })
  assert.equal((await stale.invoke('unbindPartner', 'alice')).success, true)
  assert.equal(stale.read('User', 'alice').partnerId, '')
  assert.equal(stale.read('User', 'bob').partnerId, 'carol')
  assert.equal(stale.read('User', 'carol').partnerId, 'bob')
})

test('unbinding rolls both users back when the reciprocal update fails', async () => {
  const h = harness(pairSeed())
  h.state.beforeWrite = ({ id }) => { if (id === 'bob') throw new Error('simulated unbind failure') }
  assert.equal((await h.invoke('unbindPartner', 'alice')).success, false)
  assert.equal(h.read('User', 'alice').partnerId, 'bob')
  assert.equal(h.read('User', 'bob').partnerId, 'alice')
  assert.equal(h.read('User', 'alice').bindStatus, 'bound')
  assert.equal(h.read('User', 'bob').bindStatus, 'bound')
})

test('shared kitchen names synchronize both partners and reject a stale pair', async () => {
  const h = harness(pairSeed())
  assert.equal((await h.invoke('updateKitchenName', 'alice', { kitchenName: '  周末菜单  ' })).success, true)
  assert.equal(h.read('User', 'alice').kitchenName, '周末菜单')
  assert.equal(h.read('User', 'bob').kitchenName, '周末菜单')
  const seed = pairSeed()
  seed.User.find(user => user._id === 'bob').partnerId = 'carol'
  seed.User.find(user => user._id === 'bob').kitchenName = '其他空间'
  const stale = harness(seed)
  assert.equal((await stale.invoke('updateKitchenName', 'alice', { kitchenName: '禁止写入' })).success, false)
  assert.equal(stale.read('User', 'alice').kitchenName, '两人菜单')
  assert.equal(stale.read('User', 'bob').kitchenName, '其他空间')
  assert.equal(stale.read('User', 'carol').kitchenName, undefined)
})

test('cross-space category reorder and transfer reject the whole operation', async () => {
  const h = harness(pairSeed())
  const reorder = await h.invoke('manageCategory', 'alice', { action: 'reorder', data: { orders: [{ _id: 'food', sort: 8 }, { _id: 'foreignCategory', sort: 9 }] } })
  assert.equal(reorder.success, false)
  assert.equal(h.read('Category', 'food').sort, 0)
  const transfer = await h.invoke('manageCategory', 'alice', { action: 'remove', data: { _id: 'food', transferTo: 'foreignCategory' } })
  assert.equal(transfer.success, false)
  assert.equal(h.read('DishList', 'dish1').category, 'food')
  assert.notEqual(h.read('Category', 'food'), null)
})

test('a broken reciprocal pair cannot read or reorder categories', async () => {
  const seed = pairSeed()
  seed.User.find(user => user._id === 'bob').partnerId = 'carol'
  const h = harness(seed)
  const categoriesBefore = h.rows('Category')
  const dishesBefore = h.rows('DishList')
  const list = await h.invoke('manageCategory', 'alice', { action: 'list' })
  assert.equal(list.success, false)
  assert.equal(list.data, undefined)
  const reorder = await h.invoke('manageCategory', 'alice', { action: 'reorder', data: { orders: [{ _id: 'food', sort: 19 }] } })
  assert.equal(reorder.success, false)
  assert.deepEqual(h.rows('Category'), categoriesBefore)
  assert.deepEqual(h.rows('DishList'), dishesBefore)
})

test('category removal transfers only this pair’s dishes to a matching category', async () => {
  const seed = pairSeed()
  seed.DishList.push({ _id: 'foreignWithSameCategory', coupleId: 'carol_dave', category: 'food', name: '他人数据' })
  const h = harness(seed)
  assert.equal((await h.invoke('manageCategory', 'alice', { action: 'remove', data: { _id: 'food', transferTo: 'gift' } })).success, false)
  assert.equal((await h.invoke('manageCategory', 'alice', { action: 'remove', data: { _id: 'food', transferTo: 'food2' } })).success, true)
  assert.equal(h.read('Category', 'food'), null)
  assert.equal(h.read('DishList', 'dish1').category, 'food2')
  assert.equal(h.read('DishList', 'foreignWithSameCategory').category, 'food')
  assert.equal((await h.invoke('manageCategory', 'alice', { action: 'remove', data: { _id: 'food2' } })).success, false)
})

test('category listing paginates and normalizes legacy type without changing names', async () => {
  const categories = Array.from({ length: 57 }, (_, index) => ({ _id: `category${index}`, coupleId: 'alice_bob', name: `分类${index}`, icon: '🍲', sort: index }))
  const h = harness(pairSeed({ Category: categories }))
  const result = await h.invoke('manageCategory', 'alice', { action: 'list' })
  assert.equal(result.success, true)
  assert.equal(result.data.length, 57)
  assert.equal(result.data[56].name, '分类56')
  assert.equal(result.data.every(row => row.type === 'food'), true)
})

test('notification template skips and authorization use trusted document participants', async () => {
  const saved = Object.fromEntries(TEMPLATE_ENV.map(key => [key, process.env[key]]))
  for (const key of TEMPLATE_ENV) delete process.env[key]
  try {
    const h = harness(pairSeed({ OrderList: [pendingOrder(), pendingOrder({ _id: 'foreignOrder', coupleId: 'carol_dave' })] }))
    const skipped = await h.invoke('sendNotify', 'alice', { type: 'newOrder', orderId: 'order1' })
    assert.equal(skipped.success, true)
    assert.equal(skipped.skipped, true)
    assert.equal(h.state.notifications.length, 0)
    assert.equal(h.read('OrderList', 'order1').notificationNewOrderAttempted, undefined)
    const templateId = 'real_template_123456'
    for (const [openid, event] of [
      ['alice', { type: 'newOrder', orderId: 'foreignOrder' }],
      ['bob', { type: 'newOrder', orderId: 'order1' }],
      ['alice', { type: 'newDish', dishId: 'dish1' }],
      ['', { type: 'newOrder', orderId: 'order1' }]
    ]) assert.equal((await h.invoke('sendNotify', openid, { templateId, ...event })).success, false)
    assert.equal(h.state.notifications.length, 0)
    const event = { type: 'newOrder', orderId: 'order1', templateId, partnerId: 'carol', touser: 'carol', content: 'forged content' }
    assert.equal((await h.invoke('sendNotify', 'alice', event)).success, true)
    assert.equal(h.state.notifications[0].touser, 'bob')
    assert.equal(h.state.notifications[0].data.thing2.value, '面条')
    assert.equal((await h.invoke('sendNotify', 'alice', event)).skipped, true)
    assert.equal(h.state.notifications.length, 1)
  } finally {
    for (const key of TEMPLATE_ENV) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key]
  }
})

test('status notifications are restricted to the actor responsible for that state', async () => {
  const saved = Object.fromEntries(TEMPLATE_ENV.map(key => [key, process.env[key]]))
  for (const key of TEMPLATE_ENV) delete process.env[key]
  try {
    const h = harness(pairSeed({ OrderList: [pendingOrder({ status: 'accepted', reply: '今晚做' }), pendingOrder({ _id: 'cancelledOrder', status: 'cancelled' })] }))
    const input = { type: 'orderStatus', orderId: 'order1', templateId: 'real_template_123456' }
    assert.equal((await h.invoke('sendNotify', 'alice', input)).success, false)
    assert.equal((await h.invoke('sendNotify', 'bob', input)).success, true)
    assert.equal(h.state.notifications[0].touser, 'alice')
    assert.equal((await h.invoke('sendNotify', 'bob', { ...input, orderId: 'cancelledOrder' })).success, false)
    assert.equal((await h.invoke('sendNotify', 'alice', { ...input, orderId: 'cancelledOrder' })).success, true)
    assert.equal(h.state.notifications[1].touser, 'bob')
  } finally {
    for (const key of TEMPLATE_ENV) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key]
  }
})

test('binding, unbinding, and order creation also accept SDK transaction result envelopes', async () => {
  const seed = pairSeed()
  seed.User = seed.User.map(user => ({ ...user, partnerId: '', bindStatus: 'unbound', coupleId: '' }))
  const h = harness(seed, { transactionEnvelope: true })
  assert.equal((await h.invoke('bindPartner', 'alice', { inviteCode: 'BOB001' })).success, true)
  const created = await h.invoke('manageOrder', 'alice', createInput())
  assert.equal(created.success, true)
  assert.equal(created.order.recipientId, 'bob')
  assert.equal((await h.invoke('unbindPartner', 'alice')).success, true)
  assert.equal(h.read('User', 'bob').bindStatus, 'unbound')
})
