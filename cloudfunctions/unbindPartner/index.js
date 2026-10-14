// 云函数入口文件 - 解除绑定
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database({ throwOnNotFound: false })

async function transactionResult(callback) {
  const result = await db.runTransaction(callback)
  return result && Object.prototype.hasOwnProperty.call(result, 'result') ? result.result : result
}

// 云函数入口函数
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const currentOpenid = wxContext.OPENID

  try {
    const result = await transactionResult(async transaction => {
      const users = transaction.collection('User')
      const currentUserRes = await users.doc(currentOpenid).get()
      const currentUser = currentUserRes.data
      if (!currentUser) {
        return { success: false, message: '用户不存在' }
      }

      if (currentUser.bindStatus !== 'bound' && !currentUser.partnerId) {
        return { success: false, message: '你还没有绑定伴侣' }
      }

      const partnerId = currentUser.partnerId
      let partner = null
      if (partnerId && partnerId !== currentOpenid) {
        const partnerRes = await users.doc(partnerId).get()
        partner = partnerRes.data
      }

      const unboundData = {
        partnerId: '',
        bindStatus: 'unbound',
        coupleId: ''
      }
      await users.doc(currentOpenid).update({ data: unboundData })

      // 旧数据可能是单向绑定，只清理仍然指向当前用户的对方记录。
      if (partner && partner.partnerId === currentOpenid) {
        await users.doc(partnerId).update({ data: unboundData })
      }

      return {
        success: true,
        message: '已解除绑定'
      }
    })

    if (result.success) {
      console.log('unbind partner success', currentOpenid)
    }
    return result
  } catch (err) {
    console.error('unbind partner error', err)
    return {
      success: false,
      message: '解除绑定失败，请重试',
      error: err.message
    }
  }
}
