const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database({ throwOnNotFound: false })
const _ = db.command
const BATCH_SIZE = 50
const PAGE_SIZE = 100
const MAX_FILES = 500

async function findReferences(collection, condition, fields, pending, visit) {
  // 同一张图片可能被多个商品或历史订单引用，匹配结果也需要分页。
  const query = db.collection(collection).where(condition).field(fields).orderBy('_id', 'asc')
  for (let skip = 0; pending.size; skip += PAGE_SIZE) {
    const { data } = await query.skip(skip).limit(PAGE_SIZE).get()
    for (const row of data) visit(row)
    if (data.length < PAGE_SIZE) break
  }
}

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID
  if (!openid) return { success: false, message: '请先登录' }
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { success: false, message: '请求参数不正确' }
  if (!Array.isArray(event.fileList) || !event.fileList.length) {
    return { success: false, message: '缺少文件列表' }
  }
  const fileIds = new Set()
  for (const id of event.fileList) {
    if (typeof id !== 'string' || id.length > 1000 || !id.startsWith('cloud://') || !id.slice(8).trim() || id.trim() !== id || /[\u0000-\u001f\u007f]/.test(id)) {
      return { success: false, message: '文件列表格式不正确' }
    }
    fileIds.add(id)
    if (fileIds.size > MAX_FILES) return { success: false, message: '文件数量不能超过500个' }
  }
  try {
    const { data: user } = await db.collection('User').doc(openid).get()
    if (!user) return { success: false, message: '用户不存在' }
    const pending = new Set(fileIds)
    // 首次设置头像时尚未绑定伴侣，但头像已由 createUser 保存。
    pending.delete(user.avatarUrl)
    if (pending.size && user.bindStatus === 'bound' && user.coupleId && user.partnerId) {
      const { data: partner } = await db.collection('User').doc(user.partnerId).get()
      if (partner && partner.bindStatus === 'bound' && partner.partnerId === openid && partner.coupleId === user.coupleId) {
        pending.delete(partner.avatarUrl)
        const requested = [...pending]
        for (let start = 0; start < requested.length && pending.size; start += BATCH_SIZE) {
          const batch = requested.slice(start, start + BATCH_SIZE).filter(id => pending.has(id))
          if (!batch.length) continue
          const batchPending = new Set(batch)
          const allow = id => { pending.delete(id); batchPending.delete(id) }
          await findReferences('DishList', { coupleId: user.coupleId, imageUrl: _.in(batch) }, { imageUrl: true }, batchPending, row => allow(row.imageUrl))
          // 商品删除后，历史订单仍保留自己的图片快照。
          await findReferences('OrderList', { coupleId: user.coupleId, dishes: _.elemMatch({ imageUrl: _.in(batch) }) }, { dishes: true }, batchPending, row => {
            for (const dish of row.dishes || []) allow(dish.imageUrl)
          })
          await findReferences('OrderList', { coupleId: user.coupleId, finishedPhoto: _.in(batch) }, { finishedPhoto: true }, batchPending, row => allow(row.finishedPhoto))
          if (batchPending.size) break
        }
      }
    }
    if (pending.size) return { success: false, message: '无权访问部分文件' }
    const fileList = []
    const authorized = [...fileIds]
    for (let start = 0; start < authorized.length; start += BATCH_SIZE) {
      const result = await cloud.getTempFileURL({ fileList: authorized.slice(start, start + BATCH_SIZE) })
      fileList.push(...result.fileList)
    }
    return { success: true, fileList }
  } catch (e) {
    console.error('获取文件临时链接失败', { code: typeof e.errCode === 'number' ? e.errCode : 'FILE_URL_FAILED' })
    return { success: false, message: '获取临时链接失败' }
  }
}
