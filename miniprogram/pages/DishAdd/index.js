const app = getApp()
const {
  PRODUCT_TYPES,
  normalizeProduct,
  normalizeProductType,
  getProductType,
  categoriesForType,
} = require('../../utils/product.js')
const {
  DIFFICULTY_OPTIONS,
  COOK_TIME_OPTIONS,
  DEFAULT_COOK_TIME_INDEX,
  matchCookTimeIndex,
  estimateHeight,
} = require('../../utils/recipe.js')

Page({
  data: {
    _id: '',
    name: '',
    description: '',
    type: 'food',
    typeIcon: '🍽️',
    productTypes: PRODUCT_TYPES,
    spec: '',
    imageUrl: '',
    tempFilePath: '',
    isEdit: false,
    allCategories: [],
    categories: [],
    categoryIndex: 0,
    saving: false,
    loadingDish: false,
    dishLoaded: true,

    // 菜谱字段（可选填）
    ingredients: '',
    steps: '',
    cookTime: COOK_TIME_OPTIONS[DEFAULT_COOK_TIME_INDEX].label,
    cookTimeOptions: COOK_TIME_OPTIONS,
    cookTimeIndex: DEFAULT_COOK_TIME_INDEX,
    difficulty: '简单',
    difficultyOptions: DIFFICULTY_OPTIONS,
    difficultyIndex: 0,
    ingredientsHeight: 80,
    stepsHeight: 80,
  },

  async onLoad(options) {
    await app.loadCategories()
    this.setData({ allCategories: app.globalData.categories || [] })
    this.setProductType('food')
    if (options.id) {
      this.setData({ _id: options.id, isEdit: true, loadingDish: true, dishLoaded: false })
      wx.setNavigationBarTitle({ title: '编辑商品' })
      // 编辑模式直接在 onLoad 里把字段回填，避免 onShow 早于 onLoad 完成的竞态
      await this.loadDish()
    } else {
      wx.setNavigationBarTitle({ title: '添加商品' })
    }
  },

  // 加载菜品信息（编辑模式）
  async loadDish() {
    try {
      const res = await app.callFunction({
        name: 'getCoupleData',
        data: {
          collection: app.globalData.collectionDishList,
          docId: this.data._id
        }
      })

      if (!res.result?.success) {
        throw new Error(res.result?.message || '加载失败')
      }

      const dish = normalizeProduct(res.result.data)
      this.setProductType(dish.type, dish.category)
      const difficulty = dish.difficulty && DIFFICULTY_OPTIONS.includes(dish.difficulty)
        ? dish.difficulty
        : '简单'
      const cookTimeIndex = matchCookTimeIndex(dish.cookTime)
      this.setData({
        name: dish.name,
        description: dish.description,
        spec: dish.spec || '',
        imageUrl: dish.imageUrl || '',
        ingredients: dish.ingredients || '',
        steps: dish.steps || '',
        cookTime: COOK_TIME_OPTIONS[cookTimeIndex].label,
        cookTimeIndex,
        difficulty,
        difficultyIndex: DIFFICULTY_OPTIONS.indexOf(difficulty),
        ingredientsHeight: estimateHeight(dish.ingredients),
        stepsHeight: estimateHeight(dish.steps),
        dishLoaded: true,
      })
    } catch (e) {
      console.error('加载菜品失败', e)
      wx.showToast({ title: '加载失败', icon: 'none' })
    } finally {
      this.setData({ loadingDish: false })
    }
  },

  setProductType(type, categoryId) {
    const value = normalizeProductType(type)
    const categories = categoriesForType(this.data.allCategories, value)
    const categoryIndex = categories.findIndex(category => category._id === categoryId)
    this.setData({
      type: value,
      typeIcon: getProductType(value).icon,
      categories,
      categoryIndex: categoryIndex >= 0 ? categoryIndex : 0,
    })
  },

  onTypeChange(e) {
    if (this.data.saving || this.data.loadingDish) return
    this.setProductType(e.currentTarget.dataset.type)
  },

  // 输入菜品名称
  onNameInput(e) {
    let value = e.detail.value
    if (value.length > 20) value = value.slice(0, 20)
    this.setData({ name: value })
    return value
  },

  // 输入菜品描述
  onDescInput(e) {
    let value = e.detail.value
    if (value.length > 300) value = value.slice(0, 300)
    this.setData({ description: value })
    return value
  },

  onSpecInput(e) {
    const value = e.detail.value.slice(0, 40)
    this.setData({ spec: value })
    return value
  },

  // 选择分类
  onCategoryChange(e) {
    this.setData({ categoryIndex: Number(e.detail.value) })
  },

  // 菜谱字段输入
  onIngredientsInput(e) {
    const v = e.detail.value
    this.setData({ ingredients: v, ingredientsHeight: estimateHeight(v) })
  },
  onStepsInput(e) {
    const v = e.detail.value
    this.setData({ steps: v, stepsHeight: estimateHeight(v) })
  },
  onDifficultyChange(e) {
    const idx = Number(e.detail.value)
    this.setData({ difficultyIndex: idx, difficulty: DIFFICULTY_OPTIONS[idx] })
  },
  onCookTimeChange(e) {
    const idx = Number(e.detail.value)
    this.setData({ cookTimeIndex: idx, cookTime: COOK_TIME_OPTIONS[idx].label })
  },

  // 清空已选的图片
  clearImage() {
    this.setData({ imageUrl: '', tempFilePath: '' })
  },

  // 选择图片
  chooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const tempFilePath = res.tempFiles[0].tempFilePath
        this.setData({
          tempFilePath,
          imageUrl: tempFilePath
        })
      }
    })
  },

  // 上传图片到云存储
  async uploadImage() {
    if (!this.data.tempFilePath) return ''

    const cloudPath = `dishes/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`

    try {
      const res = await app.uploadFile({
        cloudPath,
        filePath: this.data.tempFilePath
      })
      return res.fileID
    } catch (e) {
      console.error('上传图片失败', e)
      throw new Error('图片上传失败')
    }
  },

  // 保存菜品
  async saveDish() {
    if (!app.isBound()) {
      wx.showToast({ title: '请先绑定伴侣', icon: 'none' })
      return
    }

    const { name, saving, loadingDish, isEdit, _id } = this.data

    if (saving || loadingDish) return
    if (isEdit && !this.data.dishLoaded) {
      wx.showToast({ title: '请重新打开商品后编辑', icon: 'none' })
      return
    }

    if (!name.trim()) {
      wx.showToast({ title: '请输入商品名称', icon: 'none' })
      return
    }

    const selectedCategory = this.data.categories[this.data.categoryIndex]
    if (!selectedCategory) {
      wx.showToast({ title: '请先添加此类型的分类', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    wx.showLoading({ title: '保存中...' })

    try {
      let imageUrl = this.data.imageUrl

      // 如果有新选择的图片，上传新图片
      if (this.data.tempFilePath) {
        imageUrl = await this.uploadImage()
      }

      const category = selectedCategory._id

      // 菜谱字段：有食材或步骤就视为填了；否则各字段写空，避免默认值污染
      const hasRecipe = this.data.type === 'food' && !!(this.data.ingredients.trim() || this.data.steps.trim())
      const baseData = {
        type: this.data.type,
        name: name.trim(),
        description: this.data.description.trim(),
        spec: this.data.type === 'food' ? '' : this.data.spec.trim(),
        imageUrl,
        category,
        ingredients: hasRecipe ? this.data.ingredients.trim() : '',
        steps: hasRecipe ? this.data.steps.trim() : '',
        cookTime: hasRecipe ? this.data.cookTime : '',
        difficulty: hasRecipe ? this.data.difficulty : '',
      }

      if (isEdit) {
        // 编辑模式：更新现有记录
        const res = await app.callFunction({
          name: 'updateCoupleData',
          data: {
            collection: app.globalData.collectionDishList,
            docId: _id,
            action: 'update',
            data: { ...baseData, updateTime: new Date() }
          }
        })

        wx.hideLoading()

        if (!res.result?.success) {
          throw new Error(res.result?.message || '修改失败')
        }

        wx.showToast({ title: '修改成功', icon: 'success' })
      } else {
        const res = await app.callFunction({
          name: 'updateCoupleData',
          data: {
            collection: app.globalData.collectionDishList,
            action: 'add',
            data: baseData,
          }
        })
        if (!res.result?.success) {
          throw new Error(res.result?.message || '添加失败')
        }
        wx.hideLoading()
        wx.showToast({ title: '添加成功', icon: 'success' })
      }

      setTimeout(() => {
        wx.navigateBack()
      }, 1500)

    } catch (e) {
      console.error('保存失败', e)
      wx.hideLoading()
      wx.showToast({ title: e.message || '保存失败', icon: 'none' })
      this.setData({ saving: false })
    }
  },

  // 重置表单
  resetForm() {
    if (this.data.saving || this.data.loadingDish) return
    this.setProductType('food')
    this.setData({
      name: '',
      description: '',
      spec: '',
      imageUrl: '',
      tempFilePath: '',
      categoryIndex: 0,
      ingredients: '',
      steps: '',
      cookTime: COOK_TIME_OPTIONS[DEFAULT_COOK_TIME_INDEX].label,
      cookTimeIndex: DEFAULT_COOK_TIME_INDEX,
      difficulty: '简单',
      difficultyIndex: 0,
      ingredientsHeight: 80,
      stepsHeight: 80,
    })
  },
})
