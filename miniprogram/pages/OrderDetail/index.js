const app = getApp()

Page({
  data: {
    order: null,
    loading: true,
    loadError: '',
    updating: false,
    photoUpdating: false,
    replyInput: '',
    isRecipient: false,
    canAccept: false,
    canComplete: false,
    canCancel: false,
  },

  onLoad(options) {
    this._orderId = options.id || ''
  },

  onShow() {
    this.loadOrder(this._orderId)
  },

  async loadOrder(id) {
    if (this._loadingOrder) return
    this._loadingOrder = true
    this.setData({ loading: true, loadError: '' })
    try {
      if (!id) throw new Error('订单不存在')
      const { currentUser } = await app.loadUserInfo()
      if (!currentUser) throw new Error('用户信息加载失败')
      const res = await app.callFunction({ name: 'getCoupleData', data: { collection: app.globalData.collectionOrderList, docId: id } })
      if (!res.result || !res.result.success || !res.result.data) throw new Error(res.result && res.result.message || '订单加载失败')
      const order = res.result.data
      const myId = currentUser._id || currentUser.openid
      const creatorId = order.createdBy || order.creatorId || order._openid
      const partner = app.globalData.partner || {}
      const partnerId = partner._id || partner.openid
      const recipientId = order.recipientId || (creatorId === myId ? partnerId : (creatorId === partnerId ? myId : ''))
      const isRecipient = recipientId === myId && creatorId !== myId
      order.status = order.status || 'pending'
      order.statusText = ({ pending: '待接单', accepted: '进行中', completed: '已完成', cancelled: '已取消' })[order.status] || '待接单'
      order.dishes = order.dishes || []
      order.dateText = this.formatDate(order.createTime)
      order.timeText = this.formatTime(order.createTime)
      order.creatorName = creatorId === myId ? '你' : app.getPartnerName()
      await app.convertFileURLs(order.dishes, ['imageUrl'])
      if (order.finishedPhoto) {
        order._rawFinishedPhoto = order.finishedPhoto
        const urlMap = await app.getTempFileURLs([order.finishedPhoto])
        order.finishedPhoto = urlMap[order.finishedPhoto] || order.finishedPhoto
      }
      this.setData({
        order, isRecipient, replyInput: order.reply || '',
        canAccept: isRecipient && order.status === 'pending',
        canComplete: isRecipient && order.status === 'accepted',
        canCancel: creatorId === myId && order.status === 'pending'
      })
    } catch (error) {
      console.error('加载订单失败', error)
      this.setData({ loadError: error.message || '订单加载失败' })
    } finally {
      this._loadingOrder = false
      this.setData({ loading: false })
    }
  },

  retryLoad() {
    this.loadOrder(this._orderId)
  },

  formatDate(date) {
    if (!date) return ''
    const d = new Date(date.$date || date)
    if (Number.isNaN(d.getTime())) return ''
    return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`
  },

  formatTime(date) {
    if (!date) return ''
    const d = new Date(date.$date || date)
    if (Number.isNaN(d.getTime())) return ''
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  },

  onReplyInput(e) {
    this.setData({ replyInput: e.detail.value.slice(0, 200) })
  },

  async updateStatus(e) {
    if (this.data.updating) return
    const status = e.currentTarget.dataset.status
    if (!(status === 'accepted' && this.data.canAccept || status === 'completed' && this.data.canComplete || status === 'cancelled' && this.data.canCancel)) return
    this.setData({ updating: true })
    try {
      const data = { action: 'update', orderId: this.data.order._id, status }
      if (this.data.isRecipient) data.reply = this.data.replyInput.trim()
      data.templateId = (app.globalData.notifyTmplIds || []).filter(id => id && id !== 'your-template-id')[0] || ''
      const res = await app.callFunction({ name: 'manageOrder', data })
      if (!res.result || !res.result.success) throw new Error(res.result && res.result.message || '操作失败，请重试')
      await this.loadOrder(this._orderId)
      wx.showToast({ title: ({ accepted: '已接单', completed: '已完成', cancelled: '已取消' })[status], icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败，请重试', icon: 'none' })
    } finally {
      this.setData({ updating: false })
    }
  },

  reorder() {
    if (!this.data.order || !this.data.order.dishes.length || this.data.order.wish) return
    // Set before switching tabs because the target page reads it in onShow.
    app.globalData.reorderDishIds = this.data.order.dishes.map(dish => dish._id).join(',')
    wx.switchTab({ url: '/pages/Order/index' })
  },

  copyWishLink() {
    if (this.data.order && this.data.order.wish && this.data.order.wish.link) wx.setClipboardData({ data: this.data.order.wish.link })
  },

  async uploadPhoto() {
    if (!this.data.isRecipient || this.data.photoUpdating) return
    this.setData({ photoUpdating: true })
    let uploadedId = ''
    try {
      const res = await wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'] })
      if (!res.tempFiles || !res.tempFiles.length) return
      wx.showLoading({ title: '上传中...', mask: true })
      const uploadRes = await app.uploadFile({ cloudPath: `finished_photos/${this.data.order._id}_${Date.now()}.jpg`, filePath: res.tempFiles[0].tempFilePath })
      if (!uploadRes.fileID) throw new Error('照片上传失败')
      uploadedId = uploadRes.fileID
      await this.saveFinishedPhoto(uploadedId)
      wx.showToast({ title: '上传成功', icon: 'success' })
    } catch (error) {
      if (uploadedId && error.confirmedRejected) app.deleteFile({ fileList: [uploadedId] }).catch(() => {})
      if (!(error.errMsg && error.errMsg.includes('cancel'))) wx.showToast({ title: error.message || '上传失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ photoUpdating: false })
    }
  },

  async saveFinishedPhoto(fileID) {
    const res = await app.callFunction({ name: 'updateCoupleData', data: { collection: app.globalData.collectionOrderList, docId: this.data.order._id, action: 'update', data: { finishedPhoto: fileID } } })
    if (!res || !res.result || typeof res.result.success !== 'boolean') throw new Error('照片保存结果未确认，请重试')
    if (!res.result.success) {
      const error = new Error(res.result.message || '照片保存失败')
      error.confirmedRejected = true
      throw error
    }
    const previousId = this.data.order._rawFinishedPhoto || this.data.order.finishedPhoto
    const urlMap = await app.getTempFileURLs([fileID])
    this.setData({ 'order.finishedPhoto': urlMap[fileID] || fileID, 'order._rawFinishedPhoto': fileID })
    if (previousId && previousId !== fileID) app.deleteFile({ fileList: [previousId] }).catch(() => {})
  },

  previewPhoto() {
    if (this.data.order && this.data.order.finishedPhoto) wx.previewImage({ urls: [this.data.order.finishedPhoto], current: this.data.order.finishedPhoto })
  },

  changePhoto() {
    this.uploadPhoto()
  },

  deletePhoto() {
    if (!this.data.isRecipient || this.data.photoUpdating) return
    wx.showModal({
      title: '删除照片', content: '确定删除这张成果照片？',
      success: async result => {
        if (!result.confirm || this.data.photoUpdating) return
        this.setData({ photoUpdating: true })
        try {
          const rawId = this.data.order._rawFinishedPhoto || this.data.order.finishedPhoto
          const res = await app.callFunction({ name: 'updateCoupleData', data: { collection: app.globalData.collectionOrderList, docId: this.data.order._id, action: 'update', data: { finishedPhoto: '' } } })
          if (!res.result || !res.result.success) throw new Error(res.result && res.result.message || '删除失败')
          this.setData({ 'order.finishedPhoto': '', 'order._rawFinishedPhoto': '' })
          if (rawId) app.deleteFile({ fileList: [rawId] }).catch(() => {})
          wx.showToast({ title: '已删除', icon: 'success' })
        } catch (error) {
          wx.showToast({ title: error.message || '删除失败，请重试', icon: 'none' })
        } finally {
          this.setData({ photoUpdating: false })
        }
      }
    })
  },
})
