const app = getApp()
const { createOrder, getPendingRequest } = require('../Order/order-request')

Page({
  data: {
    isBound: false,
    title: '',
    description: '',
    link: '',
    expectedDate: '',
    today: '',
    types: [{ value: 'other', label: '其他' }, { value: 'food', label: '菜品' }, { value: 'membership', label: '会员' }, { value: 'gift', label: '礼物' }],
    typeIndex: 0,
    partnerName: '对方',
    submitting: false,
    pendingRequest: false,
  },

  async onShow() {
    await app.loadUserInfo()
    const date = new Date()
    this.setData({
      partnerName: app.getPartnerName(),
      today: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    })
    try {
      this.setData({ pendingRequest: !!getPendingRequest(app) })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  onTitleInput(e) { this.setData({ title: e.detail.value }) },
  onDescriptionInput(e) { this.setData({ description: e.detail.value }) },
  onLinkInput(e) { this.setData({ link: e.detail.value }) },
  onTypeChange(e) { this.setData({ typeIndex: Number(e.detail.value) }) },
  onExpectedDateChange(e) { this.setData({ expectedDate: e.detail.value }) },
  clearExpectedDate() { this.setData({ expectedDate: '' }) },

  submitWish() {
    const { title, description, link, typeIndex, types, expectedDate } = this.data
    if (!title.trim()) {
      wx.showToast({ title: '请填写心愿名称', icon: 'none' })
      return
    }
    if (link.trim() && !/^https?:\/\/[^\s]+$/i.test(link.trim())) {
      wx.showToast({ title: '请填写完整的网页链接', icon: 'none' })
      return
    }
    return this.submit({ dishIds: [], wish: { title: title.trim(), description: description.trim(), link: link.trim(), type: types[typeIndex].value }, remark: '', expectedDate })
  },

  retryPendingOrder() {
    try {
      const pending = getPendingRequest(app)
      if (!pending) {
        this.setData({ pendingRequest: false })
        return
      }
      return this.submit(pending.payload)
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
  },

  async submit(payload) {
    if (this.data.submitting) return
    if (!app.isBound()) {
      wx.showToast({ title: '请先绑定伴侣', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      const result = await createOrder(app, payload)
      if (!result) return
      this.setData({ pendingRequest: false })
      wx.redirectTo({ url: `/pages/OrderDetail/index?id=${result.orderId}` })
    } catch (error) {
      let pendingRequest = true
      try { pendingRequest = !!getPendingRequest(app) } catch (readError) {}
      this.setData({ pendingRequest })
      wx.showToast({ title: error.message || '提交未确认，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },
})
