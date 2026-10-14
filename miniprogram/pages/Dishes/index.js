const app = getApp()
const { PRODUCT_TYPES, normalizeProduct } = require('../../utils/product.js')

Page({
  data: {
    dishes: [],
    filteredDishes: [],
    search: '',
    loading: true,
    productTypes: PRODUCT_TYPES,
    currentType: '',
  },

  onShow() {
    app.setKitchenTitle()
    this.loadDishes()
  },

  // 加载菜品列表
  async loadDishes() {
    this.setData({ loading: true })
    try {
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

      const dishes = res.result.data.map(item => ({
        ...normalizeProduct(item),
        createTimeText: this.formatDate(item.createTime)
      }))
      await app.convertFileURLs(dishes, ['imageUrl'])

      this.setData({
        dishes,
        loading: false
      })
      this.filterDishes()
    } catch (e) {
      console.error('加载菜品失败', e)
      this.setData({ loading: false })
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
  },

  // 搜索
  onSearch(e) {
    const search = e.detail.value.trim()
    this.setData({ search })
    this.filterDishes()
  },

  onTypeChange(e) {
    this.setData({ currentType: e.currentTarget.dataset.type })
    this.filterDishes()
  },

  // 过滤菜品
  filterDishes() {
    const { dishes, search, currentType } = this.data
    const keyword = search.toLowerCase()
    const filtered = dishes.filter(item => {
      if (currentType && item.type !== currentType) return false
      return [item.name, item.description, item.spec].some(value =>
        String(value || '').toLowerCase().includes(keyword)
      )
    })
    this.setData({ filteredDishes: filtered })
  },

  // 跳转到添加页
  toAddPage() {
    wx.navigateTo({ url: '/pages/DishAdd/index' })
  },

  // 跳转到详情页
  toDetailPage(e) {
    const id = e.currentTarget.dataset.id
    const dish = this.data.dishes.find(item => item._id === id)
    const imageUrl = dish?.imageUrl ? encodeURIComponent(dish.imageUrl) : ''
    wx.navigateTo({ url: `/pages/DishDetail/index?id=${id}&imageUrl=${imageUrl}` })
  },

  // 长按删除确认
  showDeleteConfirm(e) {
    const id = e.currentTarget.dataset.id
    const dish = this.data.dishes.find(item => item._id === id)

    wx.showModal({
      title: '删除商品',
      content: `确定要删除「${dish.name}」吗？`,
      confirmColor: '#E53935',
      success: async (res) => {
        if (res.confirm) {
          await this.deleteDish(id)
        }
      }
    })
  },

  // 删除菜品
  async deleteDish(id) {
    wx.showLoading({ title: '删除中...', mask: true })
    try {
      const res = await app.callFunction({
        name: 'updateCoupleData',
        data: {
          collection: app.globalData.collectionDishList,
          docId: id,
          action: 'remove'
        }
      })

      wx.hideLoading()

      if (!res.result?.success) {
        throw new Error(res.result?.message || '删除失败')
      }

      // 更新本地数据
      const dishes = this.data.dishes.filter(item => item._id !== id)
      this.setData({ dishes })
      this.filterDishes()

      wx.showToast({ title: '已删除', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      console.error('删除失败', e)
      wx.showToast({ title: '删除失败', icon: 'none' })
    }
  },

  // 格式化日期
  formatDate(date) {
    if (!date) return ''
    const d = new Date(date)
    const month = (d.getMonth() + 1).toString().padStart(2, '0')
    const day = d.getDate().toString().padStart(2, '0')
    return `${month}-${day}`
  },
})
