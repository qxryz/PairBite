// 云函数入口文件 - 绑定伴侣
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database({ throwOnNotFound: false })

// 生成 coupleId：两个 openid 排序后拼接
function generateCoupleId(openid1, openid2) {
  return [openid1, openid2].sort().join('_')
}

async function transactionResult(callback) {
  const result = await db.runTransaction(callback)
  return result && Object.prototype.hasOwnProperty.call(result, 'result') ? result.result : result
}

// 云函数入口函数
exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const currentOpenid = wxContext.OPENID
  const { inviteCode } = event || {}

  if (typeof inviteCode !== 'string' || inviteCode.length !== 6) {
    return { success: false, message: '邀请码格式不正确' }
  }

  try {
    const normalizedInviteCode = inviteCode.toUpperCase()
    // 事务只支持按文档 ID 操作，先用邀请码定位用户，再在事务中重新校验。
    const partnerRes = await db.collection('User')
      .where({ inviteCode: normalizedInviteCode })
      .get()
    const partnerId = partnerRes.data.length ? partnerRes.data[0]._id : ''

    const result = await transactionResult(async transaction => {
      const users = transaction.collection('User')
      const currentUserRes = await users.doc(currentOpenid).get()
      const currentUser = currentUserRes.data

      if (!currentUser) {
        return { success: false, message: '请先完成注册' }
      }

      if (currentUser.bindStatus === 'bound' || currentUser.partnerId) {
        return { success: false, message: '你已经绑定了伴侣' }
      }

      if (!partnerId) {
        return { success: false, message: '邀请码不存在' }
      }

      if (partnerId === currentOpenid) {
        return { success: false, message: '不能绑定自己' }
      }

      const partnerRes = await users.doc(partnerId).get()
      const partner = partnerRes.data
      if (!partner || partner.inviteCode !== normalizedInviteCode) {
        return { success: false, message: '邀请码不存在' }
      }

      if (partner.bindStatus === 'bound' || partner.partnerId) {
        return { success: false, message: 'TA已经绑定了伴侣' }
      }

      const coupleId = generateCoupleId(currentOpenid, partnerId)
      const bindTime = db.serverDate()
      // 双方状态检查与写入一起提交；冲突重试时会重新检查是否已绑定。
      await users.doc(currentOpenid).update({
        data: {
          partnerId,
          bindStatus: 'bound',
          bindTime,
          coupleId
        }
      })

      await users.doc(partnerId).update({
        data: {
          partnerId: currentOpenid,
          bindStatus: 'bound',
          bindTime,
          coupleId
        }
      })

      return {
        success: true,
        message: '绑定成功',
        partner: {
          openid: partnerId,
          nickname: partner.nickname
        },
        coupleId
      }
    })

    if (result.success) {
      console.log('bind partner success', currentOpenid, partnerId, 'coupleId:', result.coupleId)
    }
    return result
  } catch (err) {
    console.error('bind partner error', err)
    return {
      success: false,
      message: '绑定失败，请重试',
      error: err.message
    }
  }
}
