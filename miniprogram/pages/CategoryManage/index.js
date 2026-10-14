const app = getApp()
const {
  PRODUCT_TYPES,
  normalizeCategory,
  categoriesForType,
  getProductType,
} = require('../../utils/product.js')

Page({
  data: {
    categories: [],
    loading: true,
    // 添加/编辑弹窗
    showModal: false,
    editingIndex: -1,
    tempName: '',
    tempIcon: '🍽️',
    tempType: 'food',
    productTypes: PRODUCT_TYPES,
    emojiList: ['🥩', '🥬', '🍲', '🍚', '🍜', '🥗', '🍰', '🥤', '🍳', '🍕', '🌮', '🍣', '🥘', '🍝', '🥙', '🍱', '🧁', '🍺', '☕', '🫕', '🍽️', '🎟️', '🎁', '💐'],
    customIcon: '',
    // 删除转移弹窗
    showTransferModal: false,
    deletingCategory: null,
    deletingDishCount: 0,
    transferTarget: '',
    transferOptions: [],
    sortChanged: false,
    saving: false,
  },

  async onShow() {
    await this.loadCategories()
  },

  async loadCategories() {
    this.setData({ loading: true })
    try {
      const result = await this.categoryAction('list')
      const categories = result.data.map(normalizeCategory)
      this.setData({ categories, sortChanged: false })
      app.globalData.categories = categories
      app.globalData.categoriesLoaded = true
    } catch (e) {
      console.error('load categories error', e)
      wx.showToast({ title: '加载失败', icon: 'none' })
    }
    this.setData({ loading: false })
  },

  async categoryAction(action, data) {
    const res = await app.callFunction({ name: 'manageCategory', data: { action, data } })
    if (!res.result?.success) throw new Error(res.result?.message || '操作失败')
    return res.result
  },

  // 显示添加弹窗
  showAddModal() {
    this.setData({
      showModal: true,
      editingIndex: -1,
      tempName: '',
      tempIcon: '🍽️',
      tempType: 'food',
      customIcon: ''
    })
  },

  // 点击分类进入编辑
  editCategory(e) {
    const index = e.currentTarget.dataset.index
    const cat = this.data.categories[index]
    this.setData({
      showModal: true,
      editingIndex: index,
      tempName: cat.name,
      tempIcon: cat.icon,
      tempType: cat.type,
      customIcon: '',
    })
  },

  selectEmoji(e) {
    this.setData({ tempIcon: e.currentTarget.dataset.emoji, customIcon: '' })
  },

  onTypeChange(e) {
    if (this.data.editingIndex >= 0 || this.data.saving) return
    const tempType = e.currentTarget.dataset.type
    this.setData({ tempType, tempIcon: getProductType(tempType).icon, customIcon: '' })
  },

  onCustomIconInput(e) {
    this.setData({ customIcon: e.detail.value })
  },

  useCustomIcon() {
    if (this.data.customIcon) {
      this.setData({ tempIcon: this.data.customIcon })
    }
  },

  onNameInput(e) {
    let value = e.detail.value
    if (value.length > 6) value = value.slice(0, 6)
    this.setData({ tempName: value })
    return value
  },

  closeModal() {
    if (this.data.saving) return
    this.setData({ showModal: false })
  },

  // 保存分类（新增或编辑）
  async saveCategory() {
    const { tempName, tempIcon, tempType, editingIndex, categories, saving } = this.data
    if (saving) return
    if (!tempName.trim()) {
      wx.showToast({ title: '请输入分类名称', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    wx.showLoading({ title: '保存中...', mask: true })

    try {
      if (editingIndex >= 0) {
        // 编辑
        await this.categoryAction('update', {
          _id: categories[editingIndex]._id,
          name: tempName.trim(),
          icon: tempIcon,
        })
      } else {
        // 新增
        await this.categoryAction('add', {
          name: tempName.trim(), icon: tempIcon, type: tempType,
        })
      }

      wx.hideLoading()
      this.setData({ showModal: false })
      await this.loadCategories()
      wx.showToast({ title: '保存成功', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      console.error('save category error', e)
      wx.showToast({ title: e.message || '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  // 删除分类
  async deleteCategory(e) {
    const index = e.currentTarget.dataset.index
    const cat = this.data.categories[index]
    const sameTypeCategories = categoriesForType(this.data.categories, cat.type)
    if (sameTypeCategories.length <= 1) {
      wx.showToast({ title: `至少保留一个${cat.typeLabel}分类`, icon: 'none' })
      return
    }

    wx.showLoading({ title: '检查中...', mask: true })

    try {
      // 查询该分类下菜品数量
      const result = await this.categoryAction('countDishes', { _id: cat._id })
      wx.hideLoading()

      const count = result.count || 0

      if (count === 0) {
        // 无菜品，直接确认删除
        wx.showModal({
          title: '确认删除',
          content: `确定删除「${cat.icon} ${cat.name}」分类？`,
          success: async (modalRes) => {
            if (!modalRes.confirm) return
            await this.removeCategory(cat._id)
          }
        })
      } else {
        // 有菜品，弹出转移弹窗
        const transferOptions = sameTypeCategories.filter(c => c._id !== cat._id)
        this.setData({
          showTransferModal: true,
          deletingCategory: cat,
          deletingDishCount: count,
          transferTarget: '',
          transferOptions
        })
      }
    } catch (e) {
      wx.hideLoading()
      console.error('delete category error', e)
      wx.showToast({ title: '操作失败', icon: 'none' })
    }
  },

  selectTransferTarget(e) {
    this.setData({ transferTarget: e.currentTarget.dataset.id })
  },

  closeTransferModal() {
    if (this.data.saving) return
    this.setData({ showTransferModal: false })
  },

  // 确认转移并删除
  async confirmDelete() {
    const { deletingCategory, transferTarget } = this.data
    if (!transferTarget || !deletingCategory || this.data.saving) return
    await this.removeCategory(deletingCategory._id, transferTarget)
  },

  async removeCategory(id, transferTo) {
    if (this.data.saving) return
    this.setData({ saving: true })
    wx.showLoading({ title: transferTo ? '转移中...' : '删除中...', mask: true })
    try {
      await this.categoryAction('remove', { _id: id, transferTo })
      wx.hideLoading()
      this.setData({ showTransferModal: false })
      await this.loadCategories()
      wx.showToast({ title: '已删除', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      console.error('delete category error', e)
      wx.showToast({ title: e.message || '操作失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  // 上移（本地交换）
  moveUp(e) {
    const index = e.currentTarget.dataset.index
    if (index <= 0) return
    const categories = [].concat(this.data.categories)
    const temp = categories[index]
    categories[index] = categories[index - 1]
    categories[index - 1] = temp
    this.setData({ categories, sortChanged: true })
  },

  // 下移（本地交换）
  moveDown(e) {
    const index = e.currentTarget.dataset.index
    if (index >= this.data.categories.length - 1) return
    const categories = [].concat(this.data.categories)
    const temp = categories[index]
    categories[index] = categories[index + 1]
    categories[index + 1] = temp
    this.setData({ categories, sortChanged: true })
  },

  // 保存排序
  async saveSortOrder() {
    if (this.data.saving) return
    this.setData({ saving: true })
    const orders = this.data.categories.map((cat, i) => ({ _id: cat._id, sort: i }))
    wx.showLoading({ title: '保存中...', mask: true })
    try {
      await this.categoryAction('reorder', { orders })
      wx.hideLoading()
      this.setData({ sortChanged: false })
      // 同步到全局
      app.globalData.categories = this.data.categories
      wx.showToast({ title: '排序已保存', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: e.message || '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  preventBubble() {},
})
