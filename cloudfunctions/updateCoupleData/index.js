const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database({ throwOnNotFound: false })
const DISH_TEXT = { name: 80, description: 300, imageUrl: 1000, ingredients: 5000, steps: 10000, cookTime: 40, difficulty: 20, spec: 40 }
const DISH_FIELDS = new Set([...Object.keys(DISH_TEXT), 'type', 'category', 'updateTime', 'recipeUpdateTime'])
function fail(message) {
  const error = new Error(message)
  error.isValidationError = true
  throw error
}
function validateData(data, allowed) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length || Object.keys(data).some(key => !allowed.has(key))) fail('包含不允许修改的字段')
}
function dishData(data, action) {
  validateData(data, DISH_FIELDS)
  const result = {}
  for (const [key, value] of Object.entries(data)) {
    if (key === 'updateTime' || key === 'recipeUpdateTime') { result[key] = db.serverDate(); continue }
    if (key === 'category') {
      if (typeof value !== 'string' || !value || value.length > 128) fail('分类格式不正确')
    } else if (key === 'type') {
      if (!['food', 'membership', 'gift'].includes(value)) fail('商品类型不正确')
    } else if (typeof value !== 'string' || value.length > DISH_TEXT[key] || (key === 'name' && !value.trim())) fail('商品内容格式不正确')
    if (key === 'imageUrl' && value && !/^(cloud:\/\/|https?:\/\/)/i.test(value)) fail('图片地址格式不正确')
    result[key] = typeof value === 'string' ? value.trim() : value
  }
  if (action === 'add' && (!result.name || !result.category)) fail('请填写名称和分类')
  return result
}
async function touchCategory(transaction, id, coupleId, type) {
  if (!id) fail('请选择分类')
  const { data: category } = await transaction.collection('Category').doc(id).get()
  if (!category || category.coupleId !== coupleId) fail('分类不存在或不属于当前菜单')
  if (type && (category.type || 'food') !== type) fail('商品与分类类型不一致')
  await transaction.collection('Category').doc(id).update({ data: { mutationVersion: db.command.inc(1) } })
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { success: false, message: '请求参数不正确' }
  const { collection, docId, action, data } = event
  if (!openid) return { success: false, message: '请先登录' }
  if (!['DishList', 'OrderList'].includes(collection) || !['add', 'update', 'remove'].includes(action)) return { success: false, message: '不支持的操作' }
  if (collection === 'OrderList' && (action !== 'update')) return { success: false, message: '订单请通过接单、完成或取消处理' }
  if (action !== 'add' && (typeof docId !== 'string' || !docId || docId.length > 128)) return { success: false, message: '文档编号不正确' }
  try {
    let updates
    if (collection === 'DishList' && ['add', 'update'].includes(action)) updates = dishData(data, action)
    if (collection === 'OrderList') {
      validateData(data, new Set(['marked', 'finishedPhoto']))
      if ('marked' in data && typeof data.marked !== 'boolean') fail('标记格式不正确')
      if ('finishedPhoto' in data && (typeof data.finishedPhoto !== 'string' || data.finishedPhoto.length > 1000 || (data.finishedPhoto && !data.finishedPhoto.startsWith('cloud://')))) fail('成果照片格式不正确')
      updates = { ...data }
    }
    const transactionResult = await db.runTransaction(async transaction => {
      const { data: user } = await transaction.collection('User').doc(openid).get()
      if (!user || !user.coupleId || !user.partnerId || user.bindStatus !== 'bound') fail('请先绑定伴侣')
      const { data: partner } = await transaction.collection('User').doc(user.partnerId).get()
      if (!partner || partner.partnerId !== openid || partner.coupleId !== user.coupleId || partner.bindStatus !== 'bound') fail('绑定状态已变化，请重新进入')
      if (action === 'add') {
        await touchCategory(transaction, updates.category, user.coupleId, updates.type || 'food')
        const result = await transaction.collection('DishList').add({ data: { ...updates, type: updates.type || 'food', coupleId: user.coupleId, _openid: openid, orderCount: 0, createTime: db.serverDate() } })
        return { success: true, _id: result._id }
      }
      const ref = transaction.collection(collection).doc(docId)
      const { data: doc } = await ref.get()
      if (!doc || doc.coupleId !== user.coupleId) fail('无权操作')
      if (collection === 'OrderList' && 'finishedPhoto' in updates) {
        const creator = doc.creatorId || doc._openid
        const recipient = doc.recipientId || (creator === openid ? user.partnerId : openid)
        if (![openid, user.partnerId].includes(creator) || recipient !== openid || creator === recipient) fail('仅收件人可以上传成果照片')
      }
      if (collection === 'DishList' && action === 'update') {
        const nextCategory = updates.category || doc.category
        if ('category' in updates || 'type' in updates) {
          await touchCategory(transaction, nextCategory, user.coupleId, updates.type || doc.type || 'food')
          if (doc.category && doc.category !== nextCategory) await touchCategory(transaction, doc.category, user.coupleId)
        }
      }
      if (action === 'remove') {
        if (doc.category) await touchCategory(transaction, doc.category, user.coupleId)
        const result = await ref.remove()
        return { success: true, removed: result.stats.removed }
      }
      const result = await ref.update({ data: updates })
      return { success: true, updated: result.stats.updated }
    })
    return transactionResult && Object.prototype.hasOwnProperty.call(transactionResult, 'result') ? transactionResult.result : transactionResult
  } catch (error) {
    console.error('updateCoupleData error', error.message)
    return { success: false, message: error.isValidationError ? error.message : '操作失败，请重试' }
  }
}
