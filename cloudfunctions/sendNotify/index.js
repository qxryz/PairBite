// 发送微信订阅消息。所有通知内容及收件人均从共享数据读取。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database({ throwOnNotFound: false })
const DEFAULT_FIELDS = { time: 'time25', title: 'thing31', content: 'thing2', remark: 'thing11' }
const STATUS_LABELS = { pending: '待处理', accepted: '进行中', completed: '已完成', cancelled: '已取消' }
function fail(message) { throw new Error(message) }
function validTemplate(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{10,150}$/.test(id) && !/your[-_]?template|placeholder/i.test(id) }
function formatTime(date) {
  const shifted = new Date(date.getTime() + 8 * 3600000)
  return `${shifted.getUTCFullYear()}年${String(shifted.getUTCMonth() + 1).padStart(2, '0')}月${String(shifted.getUTCDate()).padStart(2, '0')}日 ${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`
}
function messageData(values, fields) {
  const data = {}
  for (const [semantic, field] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(values, semantic) || !/^(thing|time|phrase|character_string)\d+$/.test(field)) fail('订阅模板字段配置不正确')
    const max = field.startsWith('thing') ? 20 : field.startsWith('phrase') ? 5 : 32
    data[field] = { value: String(values[semantic]).slice(0, max) }
  }
  return data
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { success: false, message: '请求参数不正确' }
  if (!openid) return { success: false, message: '请先登录' }
  if (!['newOrder', 'orderStatus', 'newDish'].includes(event.type)) return { success: false, message: '未知通知类型' }
  // 未配置真实模板时直接跳过，不会影响创建订单或处理订单。
  const configuredTemplate = event.type === 'orderStatus' ? (process.env.ORDER_STATUS_TEMPLATE_ID || process.env.NOTIFY_TEMPLATE_ID) : process.env.NOTIFY_TEMPLATE_ID
  const templateId = configuredTemplate || event.templateId
  if (!validTemplate(templateId)) return { success: true, skipped: true, message: '未配置订阅消息模板' }
  try {
    const fields = JSON.parse((event.type === 'orderStatus' && process.env.ORDER_STATUS_TEMPLATE_FIELDS) || process.env.NOTIFY_TEMPLATE_FIELDS || JSON.stringify(DEFAULT_FIELDS))
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) fail('订阅模板字段配置不正确')
    const transactionResult = await db.runTransaction(async transaction => {
      const { data: user } = await transaction.collection('User').doc(openid).get()
      if (!user || !user.partnerId || !user.coupleId || user.bindStatus !== 'bound') fail('未绑定伴侣')
      const { data: partner } = await transaction.collection('User').doc(user.partnerId).get()
      if (!partner || partner.partnerId !== openid || partner.coupleId !== user.coupleId || partner.bindStatus !== 'bound') fail('绑定状态已变化')
      let targetOpenid = user.partnerId
      let content, remark, page, ref, attemptField
      if (event.type === 'newDish') {
        if (typeof event.dishId !== 'string' || !event.dishId || event.dishId.length > 128) fail('缺少商品编号')
        ref = transaction.collection('DishList').doc(event.dishId)
        const { data: dish } = await ref.get()
        if (!dish || dish.coupleId !== user.coupleId || dish._openid !== openid) fail('无权发送此商品通知')
        content = dish.name || '菜单已更新'
        remark = '新商品已加入菜单'
        page = 'pages/Dishes/index'
        attemptField = 'notificationNewDishAttempted'
        if (dish[attemptField]) return { skipped: true }
      } else {
        if (typeof event.orderId !== 'string' || !event.orderId || event.orderId.length > 128) fail('缺少订单编号')
        ref = transaction.collection('OrderList').doc(event.orderId)
        const { data: order } = await ref.get()
        if (!order || order.coupleId !== user.coupleId) fail('无权发送此订单通知')
        const creator = order.creatorId || order._openid
        if (![openid, user.partnerId].includes(creator)) fail('订单创建者不属于当前关系')
        const recipient = order.recipientId || (creator === openid ? user.partnerId : openid)
        if (creator === recipient || ![openid, user.partnerId].includes(recipient)) fail('订单收件人不属于当前关系')
        const status = order.status || 'pending'
        if (event.type === 'newOrder') {
          if (creator !== openid) fail('仅创建者可发送新订单通知')
          targetOpenid = recipient
          attemptField = 'notificationNewOrderAttempted'
          remark = order.remark || '你收到一个新订单'
        } else {
          if (status === 'pending' || ((status === 'cancelled' ? creator : recipient) !== openid)) fail('无权发送此状态通知')
          targetOpenid = status === 'cancelled' ? recipient : creator
          attemptField = `notificationStatus${status}Attempted`
          remark = `订单${STATUS_LABELS[status] || status}${order.reply ? `：${order.reply}` : ''}`
        }
        if (order[attemptField]) return { skipped: true }
        content = (order.dishes || []).map(dish => dish.name).concat(order.wish ? order.wish.title : []).join('、') || '订单更新'
        page = `pages/OrderDetail/index?id=${encodeURIComponent(order._id)}`
      }
      const data = messageData({ time: formatTime(new Date()), title: user.kitchenName || 'SheWant', content, remark }, fields)
      // 一次性订阅额度只尝试消费一次；失败记录保留在订单中，不重试业务写入。
      await ref.update({ data: { [attemptField]: true } })
      return { targetOpenid, page, data }
    })
    const notification = transactionResult && Object.prototype.hasOwnProperty.call(transactionResult, 'result') ? transactionResult.result : transactionResult
    if (notification.skipped) return { success: true, skipped: true }
    const result = await cloud.openapi.subscribeMessage.send({ touser: notification.targetOpenid, templateId, page: notification.page, data: notification.data })
    return { success: true, result }
  } catch (error) {
    console.warn('sendNotify failed', error.message)
    return { success: false, message: '消息未送达，请在小程序查看订单' }
  }
}
