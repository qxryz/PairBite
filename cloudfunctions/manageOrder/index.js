const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database({ throwOnNotFound: false })

function fail(message) {
  const error = new Error(message)
  error.isValidationError = true
  throw error
}
async function transact(callback) {
  const result = await db.runTransaction(callback)
  return result && Object.prototype.hasOwnProperty.call(result, 'result') ? result.result : result
}
function text(value, max, label, required = false) {
  if (value === undefined || value === null) value = ''
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${label}格式不正确`)
  return value.trim()
}
function normalizeCreate(event) {
  if (!Array.isArray(event.dishIds) || event.dishIds.length > 30 || event.dishIds.some(id => typeof id !== 'string' || !id || id.length > 128)) fail('请选择有效商品')
  const dishIds = [...new Set(event.dishIds)]
  const requestId = text(event.requestId, 128, '请求编号', true)
  if (!/^[a-zA-Z0-9_-]+$/.test(requestId)) fail('请求编号格式不正确')
  let wish = null
  if (event.wish) {
    if (typeof event.wish !== 'object' || Array.isArray(event.wish)) fail('心愿格式不正确')
    wish = {
      title: text(event.wish.title, 80, '心愿名称', true),
      description: text(event.wish.description, 500, '心愿描述'),
      link: text(event.wish.link, 1000, '参考链接'),
      type: event.wish.type || 'other'
    }
    if (!['food', 'membership', 'gift', 'other'].includes(wish.type)) fail('心愿类型不正确')
    if (wish.link && !/^https?:\/\/[^\s]+$/i.test(wish.link)) fail('参考链接需以 http:// 或 https:// 开头')
  }
  if (!dishIds.length && !wish) fail('请选择商品或填写心愿')
  const expectedDate = text(event.expectedDate, 10, '期望日期')
  if (expectedDate && (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate) || Number.isNaN(Date.parse(`${expectedDate}T00:00:00Z`)) || new Date(`${expectedDate}T00:00:00Z`).toISOString().slice(0, 10) !== expectedDate)) fail('期望日期格式不正确')
  return { dishIds, requestId, wish, expectedDate, remark: text(event.remark, 500, '备注') }
}
async function getDoc(transaction, collection, id) {
  const result = await transaction.collection(collection).doc(id).get()
  return result.data
}
async function getPair(transaction, openid) {
  const user = await getDoc(transaction, 'User', openid)
  if (!user || !user.coupleId || user.bindStatus !== 'bound' || !user.partnerId) fail('请先绑定伴侣')
  const partner = await getDoc(transaction, 'User', user.partnerId)
  if (!partner || partner.partnerId !== openid || partner.coupleId !== user.coupleId || partner.bindStatus !== 'bound') fail('绑定状态已变化，请重新进入')
  return { user, partner }
}
function snapshot(dish) {
  return {
    _id: dish._id,
    name: dish.name || '',
    imageUrl: dish.imageUrl || '',
    category: dish.category || '',
    description: dish.description || '',
    type: ['food', 'membership', 'gift'].includes(dish.type) ? dish.type : 'food',
    spec: dish.spec || ''
  }
}
async function notify(event, order, type) {
  try {
    const response = await cloud.callFunction({ name: 'sendNotify', data: { type, orderId: order._id, templateId: event.templateId || '' } })
    if (response && response.result && response.result.success === false) {
      console.warn('订单通知未送达', { type, status: order.status || 'pending', code: 'NOTIFY_REJECTED' })
    }
  } catch (error) {
    // 订阅消息是尽力发送，订单及状态已经提交，不因通知失败重试写入。
    console.warn('订单通知调用失败', { type, status: order.status || 'pending', code: typeof error.errCode === 'number' ? error.errCode : 'CALL_FAILED' })
  }
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { success: false, message: '请先登录' }
  try {
    if (!event || typeof event !== 'object' || Array.isArray(event)) fail('请求参数不正确')
    if (event.action === 'create') {
      const input = normalizeCreate(event)
      const result = await transact(async transaction => {
        const { user, partner } = await getPair(transaction, openid)
        // 文档编号同时约束空间、创建者和请求编号；并发重试读写同一文档。
        const orderId = `order_${crypto.createHash('sha256').update(JSON.stringify([user.coupleId, openid, input.requestId])).digest('hex').slice(0, 40)}`
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex')
        const existing = await getDoc(transaction, 'OrderList', orderId)
        if (existing) {
          if (existing.coupleId !== user.coupleId || existing._openid !== openid || existing.requestFingerprint !== fingerprint) fail('请求编号已用于其他订单，请重新提交')
          return { order: existing, reused: true }
        }
        const dishes = []
        for (const id of input.dishIds) {
          const dish = await getDoc(transaction, 'DishList', id)
          if (!dish || dish.coupleId !== user.coupleId) fail('商品已移除或不属于当前菜单')
          dishes.push(dish)
        }
        const order = {
          _id: orderId,
          _openid: openid,
          creatorId: openid,
          recipientId: partner._id,
          coupleId: user.coupleId,
          dishes: dishes.map(snapshot),
          totalCount: dishes.length + (input.wish ? 1 : 0),
          wish: input.wish,
          remark: input.remark,
          expectedDate: input.expectedDate,
          status: 'pending',
          reply: '',
          marked: false,
          requestId: input.requestId,
          requestFingerprint: fingerprint,
          createTime: db.serverDate(),
          updateTime: db.serverDate()
        }
        // doc.set 由文档引用提供 _id，不将 _id 写入业务数据。
        const { _id, ...data } = order
        await transaction.collection('OrderList').doc(orderId).set({ data })
        for (const dish of dishes) {
          await transaction.collection('DishList').doc(dish._id).update({ data: { orderCount: db.command.inc(1) } })
        }
        return { order, reused: false }
      })
      try {
        const persisted = await db.collection('OrderList').doc(result.order._id).get()
        if (persisted.data) result.order = persisted.data
      } catch (error) { console.warn('read committed order failed', error.message) }
      if (!result.reused) await notify(event, result.order, 'newOrder')
      return { success: true, orderId: result.order._id, ...result }
    }
    if (event.action === 'update') {
      const orderId = text(event.orderId, 128, '订单编号', true)
      if (!['accepted', 'completed', 'cancelled'].includes(event.status)) fail('订单状态不正确')
      const reply = text(event.reply, 500, '回复')
      const result = await transact(async transaction => {
        const { user, partner } = await getPair(transaction, openid)
        const order = await getDoc(transaction, 'OrderList', orderId)
        if (!order || order.coupleId !== user.coupleId) fail('无权操作此订单')
        const creatorId = order.creatorId || order._openid
        if (![openid, partner._id].includes(creatorId)) fail('订单创建者不属于当前关系')
        const recipientId = order.recipientId || (creatorId === openid ? partner._id : openid)
        if (recipientId === creatorId || ![openid, partner._id].includes(recipientId)) fail('订单收件人不属于当前关系')
        const status = order.status || 'pending'
        const isCancel = event.status === 'cancelled'
        if ((isCancel && openid !== creatorId) || (!isCancel && openid !== recipientId)) fail('无权更新此订单状态')
        if (status === event.status) return { order: { ...order, status, creatorId, recipientId }, changed: false }
        if (!((status === 'pending' && ['accepted', 'cancelled'].includes(event.status)) || (status === 'accepted' && event.status === 'completed'))) fail('订单状态已变化，请刷新后重试')
        const updates = { status: event.status, creatorId, recipientId, reply, updateTime: db.serverDate() }
        updates[`${event.status}Time`] = db.serverDate()
        await transaction.collection('OrderList').doc(orderId).update({ data: updates })
        return { order: { ...order, ...updates }, changed: true }
      })
      try {
        const persisted = await db.collection('OrderList').doc(result.order._id).get()
        if (persisted.data) result.order = persisted.data
      } catch (error) { console.warn('read committed order failed', error.message) }
      if (result.changed) await notify(event, result.order, 'orderStatus')
      return { success: true, order: result.order }
    }
    fail('不支持的操作')
  } catch (error) {
    console.error('manageOrder error', error.message)
    return { success: false, message: error.isValidationError ? error.message : '订单操作失败，请重试' }
  }
}
