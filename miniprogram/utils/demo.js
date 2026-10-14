// 本地体验沿用云函数的数据结构，数据只保存在当前设备。
const STORAGE_KEY = 'shewant_pairbite_demo_v1'
const REQUESTER_ID = 'demo-requester'
const RECEIVER_ID = 'demo-receiver'
const COUPLE_ID = [REQUESTER_ID, RECEIVER_ID].sort().join('_')
const DEFAULT_CATEGORIES = [
  ['meat', '荤菜', '🥩'], ['vegetable', '素菜', '🥬'],
  ['soup', '汤类', '🍲'], ['rice', '主食', '🍚'],
  ['noodle', '面食', '🍜'], ['cold', '凉菜', '🥗'],
  ['dessert', '甜点', '🍰'], ['drink', '饮品', '🥤'],
  ['membership', '会员', '🎫'], ['gift', '小礼物', '🎁']
]

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function fail(message) {
  return { success: false, message }
}

function categoryId(key) {
  return 'demo-category-' + key
}

function snapshot(dish) {
  return {
    _id: dish._id,
    name: dish.name,
    description: dish.description || '',
    imageUrl: dish.imageUrl || '',
    category: dish.category,
    type: dish.type || 'food',
    spec: dish.spec || ''
  }
}

function createInitialState(now) {
  const createTime = new Date(now).toISOString()
  const user = (id, partnerId, nickname, inviteCode, avatarUrl) => ({
    _id: id, openid: id, partnerId, nickname, inviteCode, avatarUrl,
    coupleId: COUPLE_ID, bindStatus: 'bound', createTime
  })
  const products = [
    ['chicken', '照烧鸡腿', 'meat', 'food', '酱香入味'],
    ['broccoli', '清炒西兰花', 'vegetable', 'food', '清爽家常'],
    ['soup', '番茄蛋汤', 'soup', 'food', '热乎一碗'],
    ['rice', '蛋炒饭', 'rice', 'food', '米饭粒粒香'],
    ['noodles', '番茄鸡蛋面', 'noodle', 'food', '汤面一碗'],
    ['cake', '草莓蛋糕', 'dessert', 'food', '饭后甜点'],
    ['tea', '柠檬茶', 'drink', 'food', '清新柠檬香'],
    ['mango', '芒果TV月卡', 'membership', 'membership', '一起看剧'],
    ['music', '音乐会员', 'membership', 'membership', '听喜欢的歌'],
    ['flowers', '鲜花', 'gift', 'gift', '一束鲜花']
  ]
  const dishes = products.map((item, index) => ({
    _id: 'demo-dish-' + item[0], name: item[1], category: categoryId(item[2]),
    type: item[3], description: item[4], imageUrl: '', orderCount: 0,
    spec: item[0] === 'mango' ? '月卡' : item[0] === 'music' ? '按需选择平台' : '',
    ingredients: '', steps: '', cookTime: '', difficulty: '',
    coupleId: COUPLE_ID, _openid: RECEIVER_ID,
    createTime: new Date(now - index * 1000).toISOString()
  }))
  const order = (id, creatorId, recipientId, status, dish, offset, remark) => ({
    _id: id, _openid: creatorId, creatorId, recipientId, coupleId: COUPLE_ID,
    dishes: [snapshot(dish)], wish: null, remark, expectedDate: '', status,
    reply: status === 'completed' ? '已经准备好啦' : '',
    createTime: new Date(now - offset).toISOString(),
    updateTime: new Date(now - offset).toISOString(),
    isDemo: true, isSample: true
  })
  return {
    version: 1, identity: 'requester', sequence: 0,
    users: [
      user(REQUESTER_ID, RECEIVER_ID, '下单方', 'SHE001', '/images/4aa65830d0f97dad0cb40d992405e6cc-removebg-preview.png'),
      user(RECEIVER_ID, REQUESTER_ID, '接单方', 'SHE002', '/images/4240a5a23a03b63adf5962d90e183f0f-removebg-preview.png')
    ],
    categories: DEFAULT_CATEGORIES.map((item, sort) => ({
      _id: categoryId(item[0]), name: item[1], icon: item[2], sort,
      type: ['membership', 'gift'].includes(item[0]) ? item[0] : 'food',
      coupleId: COUPLE_ID, _openid: RECEIVER_ID, createTime
    })),
    dishes,
    orders: [
      order('demo-order-pending', REQUESTER_ID, RECEIVER_ID, 'pending', dishes[0], 3600000, '示例订单：今晚想吃照烧鸡腿'),
      order('demo-order-completed', RECEIVER_ID, REQUESTER_ID, 'completed', dishes[7], 86400000, '示例订单：一起看喜欢的节目')
    ]
  }
}

function createDemo(wxApi, options = {}) {
  const now = options.now || (() => Date.now())
  const stored = wxApi.getStorageSync ? wxApi.getStorageSync(STORAGE_KEY) : null
  const valid = stored && stored.version === 1 && Array.isArray(stored.users) &&
    stored.users.length === 2 && [REQUESTER_ID, RECEIVER_ID].every(id => stored.users.some(user => user && user._id === id)) &&
    ['requester', 'receiver'].includes(stored.identity) && Number.isSafeInteger(stored.sequence) && stored.sequence >= 0 && Array.isArray(stored.dishes) &&
    Array.isArray(stored.orders) && Array.isArray(stored.categories)
  let state = valid ? clone(stored) : createInitialState(now())

  function persist() {
    if (wxApi.setStorageSync) wxApi.setStorageSync(STORAGE_KEY, clone(state))
  }
  if (!valid) persist()

  function currentUser() {
    const id = state.identity === 'receiver' ? RECEIVER_ID : REQUESTER_ID
    return state.users.find(user => user._id === id)
  }
  function partnerOf(user) {
    return state.users.find(partner => partner._id === user.partnerId) || null
  }
  function boundUser() {
    const user = currentUser()
    if (!user || !user.coupleId || user.bindStatus !== 'bound') throw new Error('请先绑定伴侣')
    const partner = partnerOf(user)
    if (!partner || partner.partnerId !== user._id || partner.coupleId !== user.coupleId || partner.bindStatus !== 'bound') throw new Error('绑定状态已变化，请重新进入')
    return user
  }
  function collection(name) {
    if (name === 'DishList') return state.dishes
    if (name === 'OrderList') return state.orders
    if (name === 'Category') return state.categories
    throw new Error('不支持的集合')
  }
  function findOwn(name, id, user) {
    const doc = collection(name).find(item => item._id === id)
    if (!doc) throw new Error('记录不存在')
    if (!user.coupleId || doc.coupleId !== user.coupleId) throw new Error('无权操作')
    return doc
  }
  function nextId(prefix) {
    state.sequence += 1
    return 'demo-' + prefix + '-' + now().toString(36) + '-' + state.sequence
  }
  function itemData(data, user, old) {
    const name = typeof data.name === 'string' ? data.name.trim() : old && old.name
    if (!name || name.length > 80) throw new Error('名称需要1到80个字')
    const catId = data.category === undefined && old ? old.category : data.category
    const category = findOwn('Category', catId, user)
    const type = data.type || (old && old.type) || category.type || 'food'
    if (!['food', 'membership', 'gift'].includes(type)) throw new Error('商品类型无效')
    if (type !== (category.type || 'food')) throw new Error('商品和分类类型不一致')
    const output = { name, category: category._id, type }
    for (const key of ['description', 'imageUrl', 'ingredients', 'steps', 'cookTime', 'difficulty', 'spec']) {
      if (data[key] !== undefined) output[key] = String(data[key])
    }
    if (output.spec && output.spec.length > 40) throw new Error('规格不能超过40个字')
    return output
  }
  function getCoupleData(data) {
    const user = currentUser()
    const rows = collection(data.collection)
    if (!user.coupleId) return data.countOnly ? { success: true, total: 0 } : { success: true, data: [], total: 0 }
    if (data.docId) return { success: true, data: clone(findOwn(data.collection, data.docId, user)) }
    let filtered = rows.filter(item => item.coupleId === user.coupleId)
    if (data.todayOnly) {
      const start = Math.floor((now() + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000
      filtered = filtered.filter(item => new Date(item.createTime).getTime() >= start)
    }
    if (data.countOnly) return { success: true, total: filtered.length }
    const orderBy = data.orderBy || 'createTime'
    const direction = data.order === 'asc' ? 1 : -1
    filtered.sort((a, b) => a[orderBy] > b[orderBy] ? direction : a[orderBy] < b[orderBy] ? -direction : 0)
    const skip = Math.max(0, Number(data.skip) || 0)
    const limit = Math.min(100, Math.max(1, Number(data.limit) || 100))
    const result = filtered.slice(skip, skip + limit)
    return { success: true, data: clone(result), total: result.length }
  }
  function manageCategory(event) {
    const user = boundUser()
    const data = event.data || {}
    const own = state.categories.filter(item => item.coupleId === user.coupleId)
    switch (event.action) {
      case 'init':
        if (own.length === 0) {
          state.categories.push(...DEFAULT_CATEGORIES.map((item, sort) => ({
            _id: nextId('category'), name: item[1], icon: item[2], sort,
            type: ['membership', 'gift'].includes(item[0]) ? item[0] : 'food',
            coupleId: user.coupleId, _openid: user._id, createTime: new Date(now()).toISOString()
          })))
        }
        return { success: true }
      case 'list':
        return { success: true, data: clone(own.sort((a, b) => a.sort - b.sort)) }
      case 'add': {
        if (!data.name || !String(data.name).trim()) return fail('请输入分类名称')
        if (own.length >= 40) return fail('最多添加40个分类')
        const type = data.type || 'food'
        if (!['food', 'membership', 'gift'].includes(type)) return fail('分类类型无效')
        const category = { type, _id: nextId('category'), name: String(data.name).trim(), icon: data.icon || '📦', sort: own.reduce((max, item) => Math.max(max, item.sort), -1) + 1, coupleId: user.coupleId, _openid: user._id, createTime: new Date(now()).toISOString() }
        state.categories.push(category)
        return { success: true, _id: category._id }
      }
      case 'update': {
        const category = findOwn('Category', data._id, user)
        if (!data.name || !String(data.name).trim()) return fail('请输入分类名称')
        const type = data.type === undefined ? category.type || 'food' : data.type
        if (!['food', 'membership', 'gift'].includes(type)) return fail('分类类型无效')
        if (type !== (category.type || 'food')) {
          if (state.dishes.some(item => item.coupleId === user.coupleId && item.category === category._id)) return fail('分类中有商品，不能更改类型')
          if (!own.some(item => item._id !== category._id && (item.type || 'food') === (category.type || 'food'))) return fail('每种类型至少保留一个分类')
        }
        category.type = type
        category.name = String(data.name).trim()
        category.icon = data.icon || category.icon
        return { success: true }
      }
      case 'remove': {
        const source = findOwn('Category', data._id, user)
        if (!own.some(item => item._id !== source._id && (item.type || 'food') === (source.type || 'food'))) return fail('每种类型至少保留一个分类')
        const dishes = state.dishes.filter(item => item.coupleId === user.coupleId && item.category === data._id)
        if (dishes.length && !data.transferTo) return fail('请先选择转移分类')
        if (data.transferTo) {
          if (data.transferTo === data._id) return fail('请选择其他分类')
          const target = findOwn('Category', data.transferTo, user)
          if ((target.type || 'food') !== (source.type || 'food')) return fail('只能转移到相同类型的分类')
          dishes.forEach(item => { item.category = data.transferTo })
        }
        state.categories = state.categories.filter(item => item._id !== data._id)
        return { success: true }
      }
      case 'reorder': {
        if (!Array.isArray(data.orders) || !data.orders.length || data.orders.length > 49 || new Set(data.orders.map(item => item._id)).size !== data.orders.length) return fail('分类顺序无效')
        const changes = data.orders.map(item => ({ doc: findOwn('Category', item._id, user), sort: Number(item.sort) }))
        if (changes.some(item => !Number.isSafeInteger(item.sort) || item.sort < 0 || item.sort > 100000)) return fail('分类顺序无效')
        changes.forEach(item => { item.doc.sort = item.sort })
        return { success: true }
      }
      case 'countDishes':
        findOwn('Category', data._id, user)
        return { success: true, count: state.dishes.filter(item => item.coupleId === user.coupleId && item.category === data._id).length }
      default:
        return fail('不支持的操作')
    }
  }
  function updateCoupleData(event) {
    const user = boundUser()
    const { action, collection: name, docId } = event
    const data = event.data || {}
    if (action === 'add') {
      if (name !== 'DishList') return fail('不支持的操作')
      const doc = { ...itemData(data, user), _id: nextId('dish'), coupleId: user.coupleId, _openid: user._id, createTime: new Date(now()).toISOString(), orderCount: 0 }
      state.dishes.push(doc)
      return { success: true, _id: doc._id }
    }
    const doc = findOwn(name, docId, user)
    if (name === 'OrderList') {
      if (action !== 'update') return fail('订单不能删除，请使用订单状态操作')
      const fields = Object.keys(data)
      if (fields.some(key => !['marked', 'finishedPhoto'].includes(key))) return fail('请使用订单状态操作')
      if (data.finishedPhoto !== undefined && doc.recipientId !== user._id) return fail('只有接单方可以上传成果照片')
      if (data.marked !== undefined) doc.marked = !!data.marked
      if (data.finishedPhoto !== undefined) doc.finishedPhoto = String(data.finishedPhoto)
      return { success: true, updated: 1 }
    }
    if (name !== 'DishList') return fail('不支持的操作')
    if (action === 'update') {
      Object.assign(doc, itemData(data, user, doc), { updateTime: new Date(now()).toISOString() })
      return { success: true, updated: 1 }
    }
    if (action === 'remove') {
      state.dishes = state.dishes.filter(item => item._id !== docId)
      return { success: true, removed: 1 }
    }
    return fail('不支持的操作')
  }
  function manageOrder(data) {
    const user = boundUser()
    if (data.action === 'create') {
      const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : ''
      if (!requestId || requestId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(requestId)) return fail('缺少有效的请求标识')
      const partner = partnerOf(user)
      if (!partner || partner.coupleId !== user.coupleId || partner.partnerId !== user._id) return fail('请先绑定伴侣')
      if (!Array.isArray(data.dishIds) || data.dishIds.length > 30 || data.dishIds.some(id => typeof id !== 'string' || !id || id.length > 128)) return fail('请选择有效商品')
      const ids = [...new Set(data.dishIds)]
      let wish = null
      if (data.wish) {
        const title = String(data.wish.title || '').trim()
        if (!title || title.length > 80) return fail('心愿名称需要1到80个字')
        const description = String(data.wish.description || '').trim()
        const link = String(data.wish.link || '').trim()
        const type = data.wish.type || 'other'
        if (description.length > 500 || link.length > 1000) return fail('心愿内容过长')
        if (link && !/^https?:\/\/\S+$/i.test(link)) return fail('链接需以http://或https://开头')
        if (!['food', 'membership', 'gift', 'other'].includes(type)) return fail('心愿类型无效')
        wish = { title, description, link, type }
      }
      if (!ids.length && !wish) return fail('请选择商品或填写心愿')
      const remark = String(data.remark || '').trim()
      if (remark.length > 500) return fail('备注不能超过500个字')
      const expectedDate = String(data.expectedDate || '').trim()
      if (expectedDate && (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate) || Number.isNaN(Date.parse(expectedDate + 'T00:00:00Z')) || new Date(expectedDate + 'T00:00:00Z').toISOString().slice(0, 10) !== expectedDate)) return fail('期望日期格式不正确')
      const requestFingerprint = JSON.stringify({ dishIds: ids, requestId, wish, expectedDate, remark })
      const previous = state.orders.find(order => order.coupleId === user.coupleId && order.creatorId === user._id && order.requestId === requestId)
      if (previous) {
        if (previous.requestFingerprint !== requestFingerprint) return fail('请求编号已用于其他订单，请重新提交')
        return { success: true, orderId: previous._id, order: clone(previous), reused: true }
      }
      const dishes = ids.map(id => findOwn('DishList', id, user))
      const createTime = new Date(now()).toISOString()
      const order = {
        _id: nextId('order'), _openid: user._id, creatorId: user._id,
        recipientId: partner._id, coupleId: user.coupleId, requestId, requestFingerprint,
        dishes: dishes.map(snapshot), wish, remark, expectedDate,
        status: 'pending', reply: '', marked: false, totalCount: dishes.length + (wish ? 1 : 0), createTime, updateTime: createTime,
        isDemo: true, isSample: false
      }
      state.orders.push(order)
      dishes.forEach(dish => { dish.orderCount = (dish.orderCount || 0) + 1 })
      return { success: true, orderId: order._id, order: clone(order), reused: false }
    }
    if (data.action === 'update') {
      const order = findOwn('OrderList', data.orderId, user)
      const status = data.status
      if (!['accepted', 'completed', 'cancelled'].includes(status)) return fail('订单状态无效')
      const statusBefore = order.status || 'pending'
      const creatorId = order.creatorId || order._openid
      const recipientId = order.recipientId || (creatorId === user._id ? user.partnerId : user._id)
      const isCreator = creatorId === user._id
      const isRecipient = recipientId === user._id
      if (status === 'cancelled' ? !isCreator : !isRecipient) return fail('无权更新此订单状态')
      if (statusBefore === status) return { success: true, order: clone(order) }
      if (!((statusBefore === 'pending' && ['accepted', 'cancelled'].includes(status)) || (statusBefore === 'accepted' && status === 'completed'))) return fail('订单状态已变化，请刷新后重试')
      const reply = data.reply === undefined ? order.reply || '' : String(data.reply).trim()
      if (reply.length > 500) return fail('回复不能超过500个字')
      order.creatorId = creatorId
      order.recipientId = recipientId
      order.status = status
      order.reply = reply
      order.updateTime = new Date(now()).toISOString()
      order[status + 'Time'] = order.updateTime
      return { success: true, order: clone(order) }
    }
    return fail('不支持的操作')
  }
  function dispatch(name, data) {
    const user = currentUser()
    switch (name) {
      case 'getOpenId': return { openid: user._id }
      case 'createUser':
        if (data.nickname) user.nickname = String(data.nickname).trim().slice(0, 20)
        if (data.avatarUrl) user.avatarUrl = String(data.avatarUrl)
        return { success: true, isNew: false, user: clone(user), partner: clone(partnerOf(user)) }
      case 'getCoupleData': return getCoupleData(data)
      case 'manageCategory': return manageCategory(data)
      case 'updateCoupleData': return updateCoupleData(data)
      case 'manageOrder': return manageOrder(data)
      case 'updateKitchenName': {
        const name = String(data.kitchenName || '').trim()
        if (!name || name.length > 8) return fail('名称需要1到8个字')
        user.kitchenName = name
        const partner = partnerOf(user)
        if (partner) partner.kitchenName = name
        return { success: true }
      }
      case 'bindPartner': {
        if (user.bindStatus === 'bound') return fail('你已经绑定了伴侣')
        const partner = state.users.find(item => item.inviteCode === String(data.inviteCode || '').toUpperCase())
        if (!partner) return fail('邀请码不存在')
        if (partner._id === user._id) return fail('不能绑定自己')
        if (partner.bindStatus === 'bound') return fail('对方已经绑定了伴侣')
        const coupleId = [user._id, partner._id].sort().join('_')
        Object.assign(user, { partnerId: partner._id, bindStatus: 'bound', coupleId })
        Object.assign(partner, { partnerId: user._id, bindStatus: 'bound', coupleId })
        return { success: true, partner: clone(partner), coupleId }
      }
      case 'unbindPartner': {
        if (user.bindStatus !== 'bound') return fail('你还没有绑定伴侣')
        const partner = partnerOf(user)
        for (const item of [user, partner].filter(Boolean)) Object.assign(item, { partnerId: '', bindStatus: 'unbound', coupleId: '' })
        return { success: true }
      }
      case 'getFileURL':
        return { success: true, fileList: (data.fileList || []).map(fileID => ({ fileID, tempFileURL: fileID })) }
      case 'sendNotify':
        return { success: true, skipped: true, reason: 'demo', message: '演示模式不会发送通知' }
      default: return fail('不支持的云函数')
    }
  }

  const demo = {
    getIdentity() { return state.identity },
    setIdentity(identity) {
      if (!['requester', 'receiver'].includes(identity)) throw new Error('体验身份无效')
      const previous = state.identity
      state.identity = identity
      try { persist() } catch (error) { state.identity = previous; throw error }
      return identity
    },
    async callFunction(options) {
      const before = clone(state)
      try {
        const result = dispatch(options.name, options.data || {})
        if (result.success !== false && JSON.stringify(before) !== JSON.stringify(state)) persist()
        else state = before
        return { result: clone(result) }
      } catch (error) {
        state = before
        return { result: fail(error.message || '本地数据操作失败') }
      }
    }
  }
  return demo
}

module.exports = { createDemo, STORAGE_KEY }
