const app = getApp()

Page({
  data: {
    isBound: false,
    orders: [],
    visibleOrders: [],
    filter: 'all',
    loading: true,
    loadError: '',
    hasMore: true,
    page: 0,
    pageSize: 10,
    openid: '',
    partnerName: '',
    partnerId: '',
    showTipModal: false,
    tipText: '',
  },

  async onShow() {
    app.setKitchenTitle()
    const { currentUser, partner } = await app.loadUserInfo()
    this.setData({ openid: currentUser && (currentUser._id || currentUser.openid) || '', partnerName: partner && partner.nickname || '对方', partnerId: partner && (partner._id || partner.openid) || '' })
    await this.loadOrders(true)
  },

  async loadOrders(reset = false) {
    if (this._loadingOrders) return
    this._loadingOrders = true
    if (reset) this.setData({ page: 0, orders: [], visibleOrders: [], hasMore: true })
    this.setData({ loading: true, loadError: '' })
    try {
      const { page, pageSize, orders: existingOrders } = this.data
      const res = await app.callFunction({
        name: 'getCoupleData',
        data: { collection: app.globalData.collectionOrderList, orderBy: 'createTime', order: 'desc', skip: page * pageSize, limit: pageSize }
      })
      if (!res.result || !res.result.success) throw new Error(res.result && res.result.message || '加载失败')
      const data = res.result.data || []
      const newOrders = data.map(item => {
        const creatorId = item.createdBy || item.creatorId || item._openid
        const status = item.status || 'pending'
        return {
          ...item,
          dishes: item.dishes || [],
          status,
          statusText: ({ pending: '待接单', accepted: '进行中', completed: '已完成', cancelled: '已取消' })[status] || '待接单',
          isMine: creatorId === this.data.openid,
          isReceived: item.recipientId ? item.recipientId === this.data.openid : creatorId === this.data.partnerId,
          dateText: this.formatDate(item.createTime),
          timeText: this.formatTime(item.createTime),
          creatorName: creatorId === this.data.openid ? '你' : this.data.partnerName,
          slideButtons: this.getSlideButtons(item.marked)
        }
      })
      await app.convertFileURLs(newOrders.flatMap(order => order.dishes), ['imageUrl'])
      const orders = reset ? newOrders : existingOrders.concat(newOrders)
      this.setData({ orders, hasMore: data.length === pageSize, page: page + 1 })
      this.applyFilter()
    } catch (error) {
      console.error('加载历史失败', error)
      this.setData({ loadError: '订单加载失败，点击重试' })
    } finally {
      this._loadingOrders = false
      this.setData({ loading: false })
    }
  },

  selectFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.filter })
    this.applyFilter()
  },

  applyFilter() {
    const { orders, filter } = this.data
    const visibleOrders = orders.filter(order => filter === 'all' || (filter === 'mine' ? order.isMine : order.isReceived))
    this.setData({ visibleOrders })
  },

  retryLoad() {
    this.loadOrders(this.data.orders.length === 0)
  },

  loadMore() {
    if (this.data.hasMore && !this.data.loading) this.loadOrders()
  },

  formatDate(date) {
    if (!date) return ''
    const d = new Date(date.$date || date)
    if (Number.isNaN(d.getTime())) return ''
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    if (d.toDateString() === today.toDateString()) return '今天'
    if (d.toDateString() === yesterday.toDateString()) return '昨天'
    return `${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`
  },

  formatTime(date) {
    if (!date) return ''
    const d = new Date(date.$date || date)
    if (Number.isNaN(d.getTime())) return ''
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  },

  getSlideButtons(marked) {
    return [{ text: marked ? '取消标记' : '标记', type: 'default', extClass: 'mark-btn' }]
  },

  onSlideButtonTap(e) {
    if (e.detail.index === 0) this.toggleMark(e.currentTarget.dataset.id)
  },

  async toggleMark(id) {
    if (this._marking) return
    const index = this.data.orders.findIndex(order => order._id === id)
    if (index < 0) return
    this._marking = true
    const marked = !this.data.orders[index].marked
    try {
      const res = await app.callFunction({ name: 'updateCoupleData', data: { collection: app.globalData.collectionOrderList, docId: id, action: 'update', data: { marked } } })
      if (!res.result || !res.result.success) throw new Error(res.result && res.result.message || '标记失败')
      const orders = this.data.orders.map(order => order._id === id ? { ...order, marked, slideButtons: this.getSlideButtons(marked) } : order)
      this.setData({ orders })
      this.applyFilter()
      wx.showToast({ title: marked ? '已标记' : '已取消标记', icon: 'success' })
    } catch (error) {
      this.showTip(error.message || '标记失败，请重试')
    } finally {
      this._marking = false
    }
  },

  showTip(text) {
    this.setData({ showTipModal: true, tipText: text })
  },

  closeTipModal() {
    this.setData({ showTipModal: false })
  },

  preventClose() {},

  goToDetail(e) {
    wx.navigateTo({ url: `/pages/OrderDetail/index?id=${e.currentTarget.dataset.id}` })
  },

  onPullDownRefresh() {
    this.loadOrders(true).then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    this.loadMore()
  },
})
