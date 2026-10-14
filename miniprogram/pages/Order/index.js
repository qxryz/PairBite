const app = getApp()
const { createOrder, getPendingRequest } = require('./order-request')

Page({
  data: {
    isBound: false,
    dishes: [],
    allDishes: [],
    categories: [],
    dishesByCategory: {},
    categoryCount: {},
    selectedByCategory: {},
    currentCategory: '',
    categoryScrollId: '',
    dishScrollId: '',
    selectedCount: 0,
    selectedDishes: [],
    loading: true,
    loadError: '',
    pendingRequest: false,
    expectedDate: '',
    today: '',
    showSuccess: false,
    showRemarkModal: false,
    showCartPanel: false,
    showDishDetail: false,
    detailClosing: false,
    currentDish: null,
    detailTranslateY: 0,
    remark: '',
    submitting: false,
    partnerName: '对方',
    searchKey: '',
  },

  async onShow() {
    app.setKitchenTitle()
    await this.loadPartnerName()
    await app.loadCategories()
    try {
      this.setData({ pendingRequest: !!getPendingRequest(app), today: this.getToday() })
    } catch (error) {
      wx.showToast({ title: error.message, icon: 'none' })
    }
    await this.loadDishes()
  },

  onUnload() {
    if (this._scrollTimer) clearTimeout(this._scrollTimer)
  },

  // 获取伴侣名字
  async loadPartnerName() {
    await app.loadUserInfo()
    const partnerName = app.getPartnerName()
    this.setData({ partnerName })
  },

  // 加载菜品
  async loadDishes() {
    this.setData({ loading: true, loadError: '' })
    try {
      if (!(app.globalData.categories || []).length) await app.loadCategories(true)
      const res = await app.callFunction({
        name: 'getCoupleData',
        data: {
          collection: app.globalData.collectionDishList,
          orderBy: 'createTime',
          order: 'desc',
          limit: 100
        }
      })
      if (!res.result?.success) {
        throw new Error(res.result?.message || '加载失败')
      }
      const data = res.result.data

      // 检查是否有再来一单的菜品
      const reorderIds = app.globalData.reorderDishIds ? app.globalData.reorderDishIds.split(',') : []
      app.globalData.reorderDishIds = null

      const selectedIds = this.data.allDishes.filter(item => item.selected).map(item => item._id)
      const dishes = data.map(item => ({
        ...item,
        selected: (reorderIds.length ? reorderIds : selectedIds).includes(item._id),
        category: item.category || 'meat'
      }))
      await app.convertFileURLs(dishes, ['imageUrl'])

      const categories = app.globalData.categories || []
      if (dishes.length && !categories.length) throw new Error('分类加载失败')
      this.setData({ categories, loading: false, searchKey: '' })
      this.refreshDishView(dishes, '')

      if (reorderIds.length > 0) {
        wx.showToast({ title: this.data.selectedCount ? '已选好仍在菜单的商品' : '原订单商品已下架，请重新选择', icon: 'none' })
      }
    } catch (e) {
      console.error('加载菜品失败', e)
      this.setData({ loading: false, loadError: '商品加载失败，点击重试' })
    }
  },

  // 选择分类
  selectCategory(e) {
    const id = e.currentTarget.dataset.id
    this.setData({
      currentCategory: id,
      dishScrollId: `cat-${id}`,
      categoryScrollId: `catleft-${id}`
    })
  },

  // 搜索输入
  onSearchInput(e) {
    const searchKey = e.detail.value.trim()
    this.setData({ searchKey })
    this.filterDishes(searchKey)
  },

  // 清除搜索
  clearSearch() {
    this.setData({ searchKey: '' })
    this.filterDishes('')
  },

  // 搜索和购物车共同使用完整商品列表，筛选不会清除已选商品。
  filterDishes(searchKey) {
    this.refreshDishView(this.data.allDishes, searchKey)
  },

  refreshDishView(allDishes, searchKey = this.data.searchKey) {
    const dishes = searchKey ? allDishes.filter(d => (d.name || '').includes(searchKey) || (d.description || '').includes(searchKey)) : allDishes
    const categories = this.data.categories
    const dishesByCategory = {}
    const categoryCount = {}
    const selectedByCategory = {}
    categories.forEach(cat => {
      dishesByCategory[cat._id] = dishes.filter(d => d.category === cat._id)
      categoryCount[cat._id] = dishesByCategory[cat._id].length
      selectedByCategory[cat._id] = allDishes.filter(d => d.category === cat._id && d.selected).length
    })
    const firstCategory = categories.find(cat => categoryCount[cat._id] > 0)
    const selectedDishes = allDishes.filter(d => d.selected)
    this.setData({
      allDishes, dishes, dishesByCategory, categoryCount, selectedByCategory,
      selectedDishes, selectedCount: selectedDishes.length,
      currentCategory: firstCategory ? firstCategory._id : (categories[0] ? categories[0]._id : '')
    })
  },

  // 监听右侧滚动，同步左侧高亮
  onDishScroll(e) {
    if (this._scrollTimer) return
    this._scrollTimer = setTimeout(() => {
      this._scrollTimer = null
      this._syncCategoryHighlight()
    }, 100)
  },

  _syncCategoryHighlight() {
    const visibleCats = this.data.categories.filter(c => this.data.categoryCount[c._id] > 0)
    if (visibleCats.length === 0) return

    const query = this.createSelectorQuery()
    query.select('.dish-list').boundingClientRect()
    visibleCats.forEach(cat => {
      query.select(`#cat-${cat._id}`).boundingClientRect()
    })
    query.exec(rects => {
      if (!rects || !rects[0]) return
      const listTop = rects[0].top + 20
      let activeId = visibleCats[0]._id
      for (let i = 0; i < visibleCats.length; i++) {
        if (rects[i + 1] && rects[i + 1].top <= listTop) {
          activeId = visibleCats[i]._id
        }
      }
      if (activeId !== this.data.currentCategory) {
        this.setData({
          currentCategory: activeId,
          categoryScrollId: `catleft-${activeId}`
        })
      }
    })
  },

  // 每件商品只选择一次。
  toggleSelect(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.allDishes.find(dish => dish._id === id)
    if (item && !item.selected && this.data.selectedCount >= 30) {
      wx.showToast({ title: '每单最多选择30件商品', icon: 'none' })
      return
    }
    this.refreshDishView(this.data.allDishes.map(item => item._id === id ? { ...item, selected: !item.selected } : item))
  },

  // 切换购物车面板
  toggleCartPanel() {
    this.setData({ showCartPanel: !this.data.showCartPanel })
  },

  // 打开菜品详情面板
  openDishDetail(e) {
    const id = e.currentTarget.dataset.id
    const dish = this.data.dishes.find(d => d._id === id)
    if (dish) {
      this.setData({ showDishDetail: true, currentDish: dish })
    }
  },

  // 关闭菜品详情面板
  closeDishDetail() {
    this.setData({ detailClosing: true, detailTranslateY: 0 })
    setTimeout(() => {
      this.setData({ showDishDetail: false, detailClosing: false, currentDish: null })
    }, 300)
  },

  // 下拉关闭 - 触摸开始
  onDetailTouchStart(e) {
    this.touchStartY = e.touches[0].clientY
    this.isDragging = false
  },

  // 下拉关闭 - 触摸移动
  onDetailTouchMove(e) {
    const currentY = e.touches[0].clientY
    const deltaY = currentY - this.touchStartY
    if (deltaY > 0) {
      this.isDragging = true
      this.setData({ detailTranslateY: deltaY })
    }
  },

  // 下拉关闭 - 触摸结束
  onDetailTouchEnd() {
    const { detailTranslateY } = this.data
    if (detailTranslateY > 150) {
      this.closeDishDetail()
    } else {
      this.setData({ detailTranslateY: 0 })
    }
  },

  // 详情和购物车同步更新原商品选择状态。
  toggleDishInDetail() {
    if (!this.data.currentDish) return
    const id = this.data.currentDish._id
    this.toggleSelect({ currentTarget: { dataset: { id } } })
    this.setData({ currentDish: this.data.allDishes.find(item => item._id === id) })
  },

  removeFromCart(e) {
    const id = e.currentTarget.dataset.id
    this.refreshDishView(this.data.allDishes.map(item => item._id === id ? { ...item, selected: false } : item))
  },

  clearCart() {
    this.refreshDishView(this.data.allDishes.map(item => ({ ...item, selected: false })))
    this.setData({ showCartPanel: false })
  },

  submitOrder() {
    if (this.data.submitting) return
    if (!this.data.selectedDishes.length) {
      wx.showToast({ title: '请先选择商品', icon: 'none' })
      return
    }
    this.setData({ showRemarkModal: true })
  },

  getToday() {
    const date = new Date()
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  },

  onExpectedDateChange(e) {
    this.setData({ expectedDate: e.detail.value })
  },

  clearExpectedDate() {
    this.setData({ expectedDate: '' })
  },

  goToWish() {
    wx.navigateTo({ url: '/pages/Wish/index' })
  },

  // 输入备注
  onRemarkInput(e) {
    let value = e.detail.value
    if (value.length > 100) value = value.slice(0, 100)
    this.setData({ remark: value })
    return value
  },

  // 关闭备注弹窗
  closeRemarkModal() {
    this.setData({ showRemarkModal: false })
  },

  // 阻止冒泡
  preventClose() {},

  skipRemark() {
    return this.doSubmitOrder('')
  },

  confirmRemark() {
    return this.doSubmitOrder(this.data.remark)
  },

  retryPendingOrder() {
    return this.doSubmitOrder(this.data.remark, true)
  },

  async doSubmitOrder(remark, retry = false) {
    if (this.data.submitting) return
    if (!app.isBound()) {
      wx.showToast({ title: '请先绑定伴侣', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    try {
      const pending = retry ? getPendingRequest(app) : null
      if (retry && !pending) {
        this.setData({ pendingRequest: false })
        return
      }
      const payload = pending ? pending.payload : {
        dishIds: this.data.selectedDishes.map(item => item._id),
        remark,
        expectedDate: this.data.expectedDate
      }
      const result = await createOrder(app, payload)
      if (!result) return
      this.setData({ showSuccess: true, showRemarkModal: false, showCartPanel: false, pendingRequest: false })
    } catch (error) {
      console.error('点单失败', error)
      let pendingRequest = true
      try { pendingRequest = !!getPendingRequest(app) } catch (readError) {}
      this.setData({ pendingRequest })
      wx.showToast({ title: error.message || '提交未确认，请重试', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  // 关闭成功弹窗
  closeSuccess() {
    this.refreshDishView(this.data.allDishes.map(item => ({ ...item, selected: false })))
    this.setData({ showSuccess: false, remark: '', expectedDate: '' })
  },

  // 跳转到菜品库
  goToDishes() {
    wx.switchTab({ url: '/pages/Dishes/index' })
  },
})
