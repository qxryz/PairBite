const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const { AsyncLocalStorage } = require('node:async_hooks')

const clone = value => structuredClone(value)

function harness(seed = {}, options = {}) {
  const context = new AsyncLocalStorage()
  const store = new Map(['User', 'DishList', 'OrderList'].map(name => [name, new Map((seed[name] || []).map(row => [row._id, clone(row)]))]))
  const state = { signed: [], queries: [], calls: [], notifyResult: { success: true } }
  const matches = (value, condition) => {
    if (condition && condition.operation === 'in') return condition.values.includes(value)
    if (condition && condition.operation === 'elemMatch') return Array.isArray(value) && value.some(row => Object.entries(condition.condition).every(([key, expected]) => matches(row[key], expected)))
    return value === condition
  }
  function collection(name, query = {}) {
    const rows = store.get(name)
    return {
      doc(id) {
        return {
          async get() { return { data: clone(rows.get(id) || null) } },
          async set({ data }) { rows.set(id, { ...clone(data), _id: id }) },
          async update({ data }) {
            const row = rows.get(id)
            for (const [key, value] of Object.entries(data)) row[key] = value && value.operation === 'inc' ? (row[key] || 0) + value.value : clone(value)
          }
        }
      },
      where(condition) { return collection(name, { ...query, condition }) },
      field(fields) { return collection(name, { ...query, fields }) },
      orderBy(field, direction) { return collection(name, { ...query, field, direction }) },
      skip(skip) { return collection(name, { ...query, skip }) },
      limit(limit) { return collection(name, { ...query, limit }) },
      async get() {
        state.queries.push(clone({ collection: name, ...query }))
        let data = [...rows.values()].filter(row => Object.entries(query.condition || {}).every(([key, expected]) => matches(row[key], expected)))
        if (query.field) data.sort((a, b) => (a[query.field] > b[query.field] ? 1 : a[query.field] < b[query.field] ? -1 : 0) * (query.direction === 'desc' ? -1 : 1))
        data = data.slice(query.skip || 0, (query.skip || 0) + (query.limit || 100))
        if (query.fields) data = data.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key === '_id' || query.fields[key])))
        return { data: clone(data) }
      }
    }
  }
  const db = {
    collection,
    command: {
      in: values => ({ operation: 'in', values }),
      elemMatch: condition => ({ operation: 'elemMatch', condition }),
      inc: value => ({ operation: 'inc', value })
    },
    serverDate: () => new Date('2026-10-15T01:02:03Z'),
    async runTransaction(callback) { return callback(db) }
  }
  const sdk = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    database: () => db,
    getWXContext: () => ({ OPENID: context.getStore() || '' }),
    async getTempFileURL({ fileList }) {
      assert.ok(fileList.length <= 50, 'storage accepts at most 50 IDs per call')
      state.signed.push(clone(fileList))
      if (options.signError) throw options.signError
      return { fileList: fileList.map(fileID => ({ fileID, tempFileURL: `https://example.test/${encodeURIComponent(fileID)}`, status: 0 })) }
    },
    async callFunction(input) {
      state.calls.push(clone(input))
      return { result: clone(state.notifyResult) }
    }
  }
  const functions = {}
  const originalLoad = Module._load
  try {
    Module._load = function (request, parent, isMain) {
      return request === 'wx-server-sdk' ? sdk : originalLoad.call(this, request, parent, isMain)
    }
    for (const name of ['getFileURL', 'manageOrder']) {
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
    read: (name, id) => clone(store.get(name).get(id) || null)
  }
}

function pairSeed(extra = {}) {
  return {
    User: [
      { _id: 'alice', avatarUrl: 'cloud://alice-avatar', bindStatus: 'bound', partnerId: 'bob', coupleId: 'alice_bob' },
      { _id: 'bob', avatarUrl: 'cloud://bob-avatar', bindStatus: 'bound', partnerId: 'alice', coupleId: 'alice_bob' }
    ],
    DishList: [{ _id: 'dish1', name: '面条', coupleId: 'alice_bob', imageUrl: 'cloud://noodles', orderCount: 2 }],
    ...extra
  }
}

test('getFileURL deduplicates 123 referenced images and signs batches of at most 50', async () => {
  const ids = Array.from({ length: 123 }, (_, index) => `cloud://image-${index}`)
  const h = harness(pairSeed({ DishList: ids.map((imageUrl, index) => ({ _id: `dish${index}`, coupleId: 'alice_bob', imageUrl })) }))
  const result = await h.invoke('getFileURL', 'alice', { fileList: [...ids, ...ids.slice(0, 20)] })
  assert.equal(result.success, true)
  assert.deepEqual(h.state.signed.map(batch => batch.length), [50, 50, 23])
  assert.deepEqual(result.fileList.map(item => item.fileID), ids)
  assert.equal(h.state.queries.every(query => query.condition.coupleId === 'alice_bob'), true)
})

test('getFileURL rejects missing identity, missing users, malformed lists, and over 500 unique IDs before signing', async () => {
  const h = harness(pairSeed())
  assert.equal((await h.invoke('getFileURL', '', { fileList: ['cloud://alice-avatar'] })).success, false)
  assert.equal((await h.invoke('getFileURL', 'missing', { fileList: ['cloud://alice-avatar'] })).success, false)
  for (const event of [undefined, null, [], {}, { fileList: [] }, { fileList: 'cloud://alice-avatar' }, { fileList: [1] }, { fileList: [''] }, { fileList: ['cloud://'] }, { fileList: ['cloud://   '] }, { fileList: ['https://example.test/image'] }, { fileList: ['cloud://image\n'] }, { fileList: Array.from({ length: 501 }, (_, index) => `cloud://image${index}`) }]) {
    assert.equal((await h.invoke('getFileURL', 'alice', event)).success, false)
  }
  assert.deepEqual(h.state.signed, [])
})

test('an unbound user can sign their persisted avatar, but cannot sign unreferenced uploads', async () => {
  const h = harness({ User: [{ _id: 'alice', avatarUrl: 'cloud://avatar/Tencent Cloud.png', bindStatus: 'unbound' }] })
  const avatar = await h.invoke('getFileURL', 'alice', { fileList: ['cloud://avatar/Tencent Cloud.png'] })
  assert.equal(avatar.success, true)
  assert.equal(avatar.fileList[0].fileID, 'cloud://avatar/Tencent Cloud.png')
  assert.equal((await h.invoke('getFileURL', 'alice', { fileList: ['cloud://avatar/unreferenced.png'] })).success, false)
  assert.equal(h.state.signed.length, 1)
  assert.deepEqual(h.state.queries, [])
})

test('partner avatars require a reciprocal active relationship', async () => {
  const h = harness(pairSeed())
  assert.equal((await h.invoke('getFileURL', 'alice', { fileList: ['cloud://bob-avatar'] })).success, true)
  const seed = pairSeed()
  seed.User[1].partnerId = 'carol'
  const stale = harness(seed)
  assert.equal((await stale.invoke('getFileURL', 'alice', { fileList: ['cloud://bob-avatar', 'cloud://noodles'] })).success, false)
  assert.deepEqual(stale.state.signed, [])
  assert.equal((await stale.invoke('getFileURL', 'alice', { fileList: ['cloud://alice-avatar'] })).success, true)
})

test('foreign dish images, snapshots, finished photos, and unknown IDs are never signed', async () => {
  const h = harness(pairSeed({
    DishList: [{ _id: 'foreign', coupleId: 'carol_dave', imageUrl: 'cloud://other-dish' }],
    OrderList: [{ _id: 'foreign-order', coupleId: 'carol_dave', dishes: [{ imageUrl: 'cloud://other-snapshot' }], finishedPhoto: 'cloud://other-finished' }]
  }))
  for (const id of ['cloud://other-dish', 'cloud://other-snapshot', 'cloud://other-finished', 'cloud://unknown']) {
    const result = await h.invoke('getFileURL', 'alice', { fileList: ['cloud://alice-avatar', id], coupleId: 'carol_dave' })
    assert.equal(result.success, false)
  }
  assert.deepEqual(h.state.signed, [])
  assert.equal(h.state.queries.every(query => query.condition.coupleId === 'alice_bob'), true)
})

test('historical snapshots and finished photos remain authorized after product deletion', async () => {
  const oldOrders = Array.from({ length: 150 }, (_, index) => ({ _id: `old${index}`, coupleId: 'alice_bob', dishes: [{ imageUrl: `cloud://unrequested-${index}` }] }))
  const h = harness(pairSeed({ DishList: [], OrderList: [...oldOrders, { _id: 'target', coupleId: 'alice_bob', dishes: [{ _id: 'deleted-dish', imageUrl: 'cloud://snapshot' }], finishedPhoto: 'cloud://finished' }] }))
  const result = await h.invoke('getFileURL', 'alice', { fileList: ['cloud://snapshot', 'cloud://finished'] })
  assert.equal(result.success, true)
  assert.deepEqual(result.fileList.map(item => item.fileID), ['cloud://snapshot', 'cloud://finished'])
  assert.ok(h.state.queries.find(query => query.condition.dishes?.operation === 'elemMatch'))
  assert.ok(h.state.queries.find(query => query.condition.finishedPhoto?.operation === 'in'))
})

test('matching historical references paginate past 100 repeated images', async () => {
  const repeated = Array.from({ length: 100 }, (_, index) => ({ _id: `a${String(index).padStart(3, '0')}`, coupleId: 'alice_bob', dishes: [{ imageUrl: 'cloud://common' }] }))
  const h = harness(pairSeed({ DishList: [], OrderList: [...repeated, { _id: 'z-last', coupleId: 'alice_bob', dishes: [{ imageUrl: 'cloud://historical' }] }] }))
  const result = await h.invoke('getFileURL', 'alice', { fileList: ['cloud://common', 'cloud://historical'] })
  assert.equal(result.success, true)
  assert.deepEqual(h.state.queries.filter(query => query.collection === 'OrderList').map(query => query.skip), [0, 100])
})

test('file signing failures return a stable error without logging file or user identifiers', async t => {
  const warnings = t.mock.method(console, 'error', () => {})
  const h = harness(pairSeed(), { signError: Object.assign(new Error('secret-openid secret-key cloud://private'), { errCode: -501 }) })
  const result = await h.invoke('getFileURL', 'alice', { fileList: ['cloud://alice-avatar'] })
  assert.deepEqual(result, { success: false, message: '获取临时链接失败' })
  assert.equal(warnings.mock.callCount(), 1)
  assert.equal(warnings.mock.calls[0].arguments[1].code, -501)
  assert.doesNotMatch(JSON.stringify(warnings.mock.calls[0].arguments), /secret|private|alice/)
})

test('notification business failures warn once per committed action while orders remain successful', async t => {
  const warnings = t.mock.method(console, 'warn', () => {})
  const h = harness(pairSeed())
  h.state.notifyResult = { success: false, message: 'secret-openid secret-template-key' }
  const create = { action: 'create', dishIds: ['dish1'], requestId: 'notify-failure' }
  const created = await h.invoke('manageOrder', 'alice', create)
  assert.equal(created.success, true)
  assert.equal(h.read('OrderList', created.orderId).status, 'pending')
  assert.equal(h.read('DishList', 'dish1').orderCount, 3)
  assert.equal((await h.invoke('manageOrder', 'alice', create)).reused, true)
  const update = { action: 'update', orderId: created.orderId, status: 'accepted' }
  assert.equal((await h.invoke('manageOrder', 'bob', update)).success, true)
  assert.equal((await h.invoke('manageOrder', 'bob', update)).success, true)
  assert.equal(h.read('OrderList', created.orderId).status, 'accepted')
  assert.equal(h.state.calls.length, 2)
  assert.equal(warnings.mock.callCount(), 2)
  assert.deepEqual(warnings.mock.calls.map(call => call.arguments[1]), [
    { type: 'newOrder', status: 'pending', code: 'NOTIFY_REJECTED' },
    { type: 'orderStatus', status: 'accepted', code: 'NOTIFY_REJECTED' }
  ])
  assert.doesNotMatch(JSON.stringify(warnings.mock.calls.map(call => call.arguments)), /secret|alice|bob/)
})
