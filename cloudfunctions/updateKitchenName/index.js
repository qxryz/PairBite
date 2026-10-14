// 更新双方共享名称；解绑或改绑不能把名称写入第三人的空间。
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database({ throwOnNotFound: false })

exports.main = async (event = {}) => {
  const openid = cloud.getWXContext().OPENID
  const kitchenName = event && event.kitchenName
  if (!openid) return { success: false, message: '请先登录' }
  if (typeof kitchenName !== 'string' || !kitchenName.trim() || [...kitchenName.trim()].length > 8) return { success: false, message: '名称需为1至8个字' }
  try {
    const result = await db.runTransaction(async transaction => {
      const users = transaction.collection('User')
      const { data: user } = await users.doc(openid).get()
      if (!user) return { success: false, message: '用户不存在' }
      if (user.partnerId && user.bindStatus === 'bound') {
        const { data: partner } = await users.doc(user.partnerId).get()
        if (!partner || partner.partnerId !== openid || partner.coupleId !== user.coupleId || partner.bindStatus !== 'bound') return { success: false, message: '绑定状态已变化，请重新进入' }
        await users.doc(user.partnerId).update({ data: { kitchenName: kitchenName.trim() } })
      }
      await users.doc(openid).update({ data: { kitchenName: kitchenName.trim() } })
      return { success: true }
    })
    return result && Object.prototype.hasOwnProperty.call(result, 'result') ? result.result : result
  } catch (error) {
    console.error('update kitchen name error', error.message)
    return { success: false, message: '更新失败，请重试' }
  }
}
