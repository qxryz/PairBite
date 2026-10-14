const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database({ throwOnNotFound: false })
const _ = db.command
const SORT_FIELDS = {
  DishList: ['createTime', 'updateTime', 'orderCount', 'name'],
  OrderList: ['createTime', 'updateTime', 'expectedDate'],
  Category: ['sort', 'createTime', 'name']
}

exports.main = async (event = {}) => {
  const currentOpenid = cloud.getWXContext().OPENID
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { success: false, message: '请求参数不正确' }
  const { collection, docId, orderBy = 'createTime', order = 'desc', limit = 100, skip = 0, countOnly = false, todayOnly = false } = event
  if (!currentOpenid) return { success: false, message: '请先登录' }
  if (!Object.prototype.hasOwnProperty.call(SORT_FIELDS, collection)) return { success: false, message: '不支持的集合' }
  if (!SORT_FIELDS[collection].includes(orderBy) || !['asc', 'desc'].includes(order) || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(skip) || skip < 0 || skip > 10000 || (docId !== undefined && (typeof docId !== 'string' || !docId || docId.length > 128)) || typeof countOnly !== 'boolean' || typeof todayOnly !== 'boolean') {
    return { success: false, message: '查询参数不正确' }
  }
  try {
    const userRes = await db.collection('User').doc(currentOpenid).get()
    const currentUser = userRes.data
    if (!currentUser) return { success: false, message: '用户不存在' }
    const coupleId = currentUser.coupleId
    if (!coupleId || currentUser.bindStatus !== 'bound') return countOnly ? { success: true, total: 0 } : { success: true, data: [], total: 0 }
    if (docId) {
      const { data: doc } = await db.collection(collection).doc(docId).get()
      if (!doc || doc.coupleId !== coupleId) return { success: false, message: '无权访问' }
      return { success: true, data: doc }
    }
    const whereCondition = { coupleId }
    if (todayOnly) {
      // 云端时区不一定为北京时间。
      const now = Date.now()
      const start = Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000
      whereCondition.createTime = _.gte(new Date(start))
    }
    const query = db.collection(collection).where(whereCondition)
    if (countOnly) {
      const countRes = await query.count()
      return { success: true, total: countRes.total }
    }
    const res = await query.orderBy(orderBy, order).skip(skip).limit(limit).get()
    return { success: true, data: res.data, total: res.data.length }
  } catch (error) {
    console.error('getCoupleData error', error.message)
    return { success: false, message: '查询失败，请重试' }
  }
}
