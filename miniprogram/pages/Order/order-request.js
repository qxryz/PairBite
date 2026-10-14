function storageKey(app) {
  const user = app.globalData.currentUser || {}
  return `pending_order_${app.globalData.isDemo ? 'demo' : 'cloud'}_${user._id || user.openid || ''}_${user.coupleId || 'unbound'}`
}

function readPending(key) {
  try {
    const entry = wx.getStorageSync(key)
    return entry && entry.payload && entry.payload.requestId ? entry : null
  } catch (error) {
    throw new Error('无法读取提交记录，请重试')
  }
}

function getPendingRequest(app) {
  return readPending(storageKey(app))
}

function contentKey(payload) {
  return JSON.stringify({
    dishIds: (payload.dishIds || []).slice().sort(),
    wish: payload.wish || null,
    remark: payload.remark || '',
    expectedDate: payload.expectedDate || ''
  })
}

function confirmRetry() {
  return new Promise(resolve => wx.showModal({
    title: '有一笔订单待确认',
    content: '当前内容已更改。请先重试上次提交，确认结果后再下新订单。',
    confirmText: '重试原订单',
    cancelText: '暂不提交',
    success: result => resolve(result.confirm),
    fail: () => resolve(false)
  }))
}

async function prepareRequest(app, payload, key) {
  const pending = readPending(key)
  if (pending) {
    if (contentKey(pending.payload) !== contentKey(payload) && !await confirmRetry()) return null
    return pending.payload
  }
  const request = {
    ...payload,
    action: 'create',
    templateId: (app.globalData.notifyTmplIds || []).filter(id => id && id !== 'your-template-id')[0] || '',
    requestId: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`
  }
  try {
    wx.setStorageSync(key, { payload: request })
  } catch (error) {
    throw new Error('暂时无法保存提交记录，请重试')
  }
  return request
}

function requestSubscription(app) {
  const ids = (app.globalData.notifyTmplIds || []).filter(id => id && id !== 'your-template-id')
  if (!ids.length) return Promise.resolve()
  return new Promise(resolve => {
    try {
      app.requestSubscribeMessage({ tmplIds: ids, complete: resolve })
    } catch (error) { resolve() }
  })
}

async function createOrder(app, payload) {
  const key = storageKey(app)
  const request = await prepareRequest(app, payload, key)
  if (!request) return null
  await requestSubscription(app)
  if (storageKey(app) !== key) throw new Error('绑定关系已变化，请重新进入页面')
  const result = await app.callFunction({ name: 'manageOrder', data: request })
  if (!result || !result.result || typeof result.result.success !== 'boolean') throw new Error('提交结果未确认，请重试')
  if (!result.result.success) {
    // An explicit rejection means the server did not create this order.
    try { wx.removeStorageSync(key) } catch (error) {}
    throw new Error(result.result.message || '提交失败，请重试')
  }
  // Remove only the request whose server response has been confirmed.
  try {
    const pending = readPending(key)
    if (pending && pending.payload.requestId === request.requestId) wx.removeStorageSync(key)
  } catch (error) {
    // A retained token is safe: the server returns the same order on the next retry.
  }
  return result.result
}

module.exports = { createOrder, getPendingRequest }
