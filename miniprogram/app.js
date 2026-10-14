const { envList = [], notifyTmplIds = [] } = require('./envList.js')
const { createDemo } = require('./utils/demo.js')

// 全局页面绑定拦截器 —— 白名单之外的页面自动校验绑定状态
const _originalPage = Page
const _bindWhitelist = ['pages/MainPage/index', 'pages/Settings/index', 'pages/Bind/index']

Page = function(options) {
  const originalOnShow = options.onShow
  options.onShow = function(...args) {
    const app = getApp()
    const pages = getCurrentPages()
    const route = pages[pages.length - 1]?.route || ''
    const whitelisted = _bindWhitelist.some(w => route.includes(w))

    if (!whitelisted && app && app.bindGuard && !app.bindGuard(this)) {
      return
    }

    if (originalOnShow) {
      return originalOnShow.apply(this, args)
    }
  }
  _originalPage(options)
}

App({
  async onLaunch() {
    this.globalData = {
      // 当前用户信息（动态获取）
      currentUser: null,
      // 伴侣信息（动态获取）
      partner: null,
      // 用户信息是否已加载
      userLoaded: false,
      // 用户信息加载Promise
      userLoadPromise: null,

      // 云数据库集合名称
      collectionDishList: 'DishList',
      collectionOrderList: 'OrderList',

      // 应用信息
      appName: 'SheWant心愿小店',
      version: '1.0.0',

      // 订阅消息模板ID
      notifyTmplIds: notifyTmplIds.filter(id => typeof id === 'string' && id.trim() && !/your[-_]?template[-_]?id/i.test(id)),

      // 菜品分类（从数据库动态加载）
      categories: [],
      categoriesLoaded: false,
      isDemo: false,
      demoIdentity: 'requester',
    }
    this.initcloud()
  },

  // 空环境明确使用本机体验；配置环境后所有请求都交给云开发。
  initcloud() {
    const envId = typeof envList[0]?.envId === 'string' ? envList[0].envId.trim() : ''
    this.globalData.isDemo = !envId
    this._cloudError = null
    if (!envId) {
      this._demo = createDemo(wx)
      this.globalData.demoIdentity = this._demo.getIdentity()
      return
    }
    this._demo = null
    try {
      if (!wx.cloud) throw new Error('当前微信版本不支持云开发')
      wx.cloud.init({ traceUser: true, env: envId })
    } catch (error) {
      this._cloudError = error
      console.error('云环境初始化失败', error)
    }
  },

  cloud() {
    if (this.globalData.isDemo) throw new Error('本地体验不连接云环境')
    if (this._cloudError) throw this._cloudError
    if (!wx.cloud) throw new Error('当前微信版本不支持云开发')
    return wx.cloud
  },

  _withCallbacks(promise, options) {
    return Promise.resolve(promise).then(result => {
      if (typeof options.success === 'function') options.success(result)
      if (typeof options.complete === 'function') options.complete(result)
      return result
    }, error => {
      if (typeof options.fail === 'function') options.fail(error)
      if (typeof options.complete === 'function') options.complete(error)
      throw error
    })
  },

  callFunction(options) {
    if (this.globalData.isDemo) return this._withCallbacks(this._demo.callFunction(options), options)
    return this.cloud().callFunction(options)
  },

  uploadFile(options) {
    if (!this.globalData.isDemo) return this.cloud().uploadFile(options)
    const promise = new Promise((resolve, reject) => {
      if (!options.filePath) return reject(new Error('请选择图片'))
      const fileSystem = wx.getFileSystemManager && wx.getFileSystemManager()
      const saveFile = typeof wx.saveFile === 'function' ? wx.saveFile.bind(wx) : fileSystem && fileSystem.saveFile && fileSystem.saveFile.bind(fileSystem)
      if (!saveFile) return reject(new Error('当前微信版本不支持保存本地图片'))
      saveFile({
        tempFilePath: options.filePath,
        success: result => resolve({ fileID: result.savedFilePath, isDemo: true }),
        fail: reject
      })
    })
    return this._withCallbacks(promise, options)
  },

  deleteFile(options) {
    if (!this.globalData.isDemo) return this.cloud().deleteFile(options)
    // 本地照片可能被商品或订单快照复用，移除字段即可保留其他记录的图片。
    const result = { fileList: (options.fileList || []).map(fileID => ({ fileID, status: 0 })), isDemo: true }
    return this._withCallbacks(Promise.resolve(result), options)
  },

  requestSubscribeMessage(options = {}) {
    const tmplIds = (options.tmplIds || this.globalData.notifyTmplIds || [])
      .filter(id => typeof id === 'string' && id.trim() && !/your[-_]?template[-_]?id/i.test(id))
    if (this.globalData.isDemo || !tmplIds.length) {
      const result = {
        skipped: true,
        reason: this.globalData.isDemo ? 'demo' : 'not-configured',
        errMsg: this.globalData.isDemo ? '演示模式不发送订阅消息' : '订阅消息暂未配置'
      }
      if (typeof options.complete === 'function') options.complete(result)
      return Promise.resolve(result)
    }
    return wx.requestSubscribeMessage({ ...options, tmplIds })
  },

  getDemoIdentity() {
    return this.globalData.isDemo ? this._demo.getIdentity() : null
  },

  async setDemoIdentity(identity) {
    if (!this.globalData.isDemo) throw new Error('仅本地体验可以切换身份')
    this._demo.setIdentity(identity)
    this.globalData.demoIdentity = identity
    this.globalData.currentUser = null
    this.globalData.partner = null
    this.globalData.userLoaded = false
    this.globalData.userLoadPromise = null
    this.globalData.categories = []
    this.globalData.categoriesLoaded = false
    this.globalData.reorderDishIds = null
    this._tempUrlCache = {}
    return this.loadUserInfo(true)
  },

  // 加载用户信息（带缓存）
  async loadUserInfo(forceRefresh = false) {
    // 如果已加载且不强制刷新，直接返回
    if (this.globalData.userLoaded && !forceRefresh) {
      return {
        currentUser: this.globalData.currentUser,
        partner: this.globalData.partner
      }
    }

    // 如果正在加载中，等待加载完成
    if (this.globalData.userLoadPromise && !forceRefresh) {
      return this.globalData.userLoadPromise
    }

    // 开始加载
    const generation = (this._userLoadGeneration || 0) + 1
    this._userLoadGeneration = generation
    const promise = this._doLoadUserInfo(generation)
    this.globalData.userLoadPromise = promise
    promise.finally(() => {
      if (this.globalData.userLoadPromise === promise) this.globalData.userLoadPromise = null
    })
    return promise
  },

  // 实际加载用户信息
  async _doLoadUserInfo(generation) {
    try {
      const res = await this.callFunction({ name: 'createUser' })
      if (res.result && res.result.success) {
        // 转换头像为临时链接
        const avatarIds = [res.result.user?.avatarUrl, res.result.partner?.avatarUrl].filter(u => u && u.startsWith('cloud://'))
        if (avatarIds.length > 0) {
          const urlMap = await this.getTempFileURLs(avatarIds)
          if (res.result.user?.avatarUrl && urlMap[res.result.user.avatarUrl]) {
            res.result.user.avatarUrl = urlMap[res.result.user.avatarUrl]
          }
          if (res.result.partner?.avatarUrl && urlMap[res.result.partner.avatarUrl]) {
            res.result.partner.avatarUrl = urlMap[res.result.partner.avatarUrl]
          }
        }
        if (generation !== this._userLoadGeneration) return { currentUser: this.globalData.currentUser, partner: this.globalData.partner }
        this.globalData.currentUser = res.result.user
        this.globalData.partner = res.result.partner
        this.globalData.userLoaded = true
        // 已绑定时加载分类
        if (res.result.user?.bindStatus === 'bound') {
          await this.loadCategories()
        }
        return {
          currentUser: res.result.user,
          partner: res.result.partner
        }
      }
    } catch (e) {
      console.error('load user info error', e)
    }
    return { currentUser: null, partner: null }
  },

  // 加载分类数据
  async loadCategories(forceRefresh = false) {
    if (this.globalData.categoriesLoaded && !forceRefresh) {
      return this.globalData.categories
    }
    try {
      // 先确保初始化默认分类
      await this.callFunction({
        name: 'manageCategory',
        data: { action: 'init' }
      })
      // 加载分类列表
      const res = await this.callFunction({
        name: 'manageCategory',
        data: { action: 'list' }
      })
      if (res.result?.success) {
        this.globalData.categories = res.result.data
        this.globalData.categoriesLoaded = true
        return res.result.data
      }
    } catch (e) {
      console.error('load categories error', e)
    }
    return []
  },

  // 更新用户昵称
  async updateNickname(nickname) {
    try {
      const res = await this.callFunction({
        name: 'createUser',
        data: { nickname }
      })
      if (res.result && res.result.success) {
        this.globalData.currentUser = res.result.user
        return true
      }
    } catch (e) {
      console.error('update nickname error', e)
    }
    return false
  },

  // 绑定伴侣
  async bindPartner(inviteCode) {
    try {
      const res = await this.callFunction({
        name: 'bindPartner',
        data: { inviteCode }
      })
      if (res.result && res.result.success) {
        // 刷新用户信息（会自动加载分类）
        await this.loadUserInfo(true)
        return { success: true, partner: res.result.partner }
      }
      return { success: false, message: res.result?.message || '绑定失败' }
    } catch (e) {
      console.error('bind partner error', e)
      return { success: false, message: '绑定失败，请重试' }
    }
  },

  // 解除绑定
  async unbindPartner() {
    try {
      const res = await this.callFunction({ name: 'unbindPartner' })
      if (res.result && res.result.success) {
        this.globalData.partner = null
        if (this.globalData.currentUser) {
          this.globalData.currentUser.partnerId = ''
          this.globalData.currentUser.bindStatus = 'unbound'
          this.globalData.currentUser.coupleId = ''
        }
        this.globalData.categories = []
        this.globalData.categoriesLoaded = false
        return { success: true }
      }
      return { success: false, message: res.result?.message || '解绑失败' }
    } catch (e) {
      console.error('unbind partner error', e)
      return { success: false, message: '解绑失败，请重试' }
    }
  },

  // 检查是否已绑定伴侣
  isBound() {
    return !!(this.globalData.currentUser?.bindStatus === 'bound' && this.globalData.partner)
  },

  // 检查用户信息是否完整（有昵称和头像）
  isProfileComplete() {
    const user = this.globalData.currentUser
    return user?.nickname && user?.avatarUrl
  },

  // 页面绑定守卫：仅设置绑定状态到页面 data，不拦截页面展示
  bindGuard(page) {
    page.setData({ isBound: this.isBound() })
    return true
  },

  // 获取伴侣名字
  getPartnerName() {
    return this.globalData.partner?.nickname || '对方'
  },

  // 获取当前用户名字
  getCurrentUserName() {
    return this.globalData.currentUser?.nickname || '我'
  },

  // 根据 openid 获取显示名称
  getDisplayName(openid) {
    if (openid === this.globalData.currentUser?._id || openid === this.globalData.currentUser?.openid) {
      return '你'
    }
    if (openid === this.globalData.partner?.openid || openid === this.globalData.partner?._id) {
      return this.globalData.partner?.nickname || '对方'
    }
    return '未知'
  },

  // 获取厨房名称（自定义或默认）
  getKitchenName() {
    return this.globalData.currentUser?.kitchenName || this.globalData.appName
  },

  // 设置页面导航栏标题为厨房名称
  setKitchenTitle() {
    const title = this.getKitchenName()
    wx.setNavigationBarTitle({ title })
  },

  // 临时链接缓存（fileID -> { url, expireTime }）
  _tempUrlCache: {},

  // 批量将 cloud:// fileID 转为临时链接
  async getTempFileURLs(fileIds) {
    if (!fileIds || fileIds.length === 0) return {}

    const now = Date.now()
    const result = {}
    const needFetch = []

    for (const id of fileIds) {
      if (!id || !id.startsWith('cloud://')) continue;
      const cached = this._tempUrlCache[id]
      if (cached && cached.expireTime > now) {
        result[id] = cached.url
      } else {
        needFetch.push(id)
      }
    }

    if (needFetch.length > 0) {
      try {
        const res = await this.callFunction({
          name: 'getFileURL',
          data: { fileList: needFetch }
        })
        if (res.result?.success) {
          for (const item of res.result.fileList) {
            if (item.tempFileURL) {
              result[item.fileID] = item.tempFileURL
              // 缓存 1.5 小时（临时链接有效期约 2 小时）
              this._tempUrlCache[item.fileID] = {
                url: item.tempFileURL,
                expireTime: now + 90 * 60 * 1000
              }
            }
          }
        }
      } catch (e) {
        console.error('getTempFileURLs error', e)
      }
    }

    return result
  },

  // 批量转换数组中对象的指定字段为临时链接，原始值保留到 _raw_xxx
  async convertFileURLs(items, fields) {
    const allIds = []
    for (const item of items) {
      for (const field of fields) {
        const val = item[field]
        if (val && val.startsWith('cloud://')) allIds.push(val)
      }
    }
    const urlMap = await this.getTempFileURLs(allIds)
    for (const item of items) {
      for (const field of fields) {
        const raw = item[field]
        if (urlMap[raw] && urlMap[raw] !== raw) {
          item['_raw_' + field] = raw
          item[field] = urlMap[raw]
        }
      }
    }
    return items
  },

  // 更新厨房名称（同步到伴侣）
  async updateKitchenName(name) {
    if (!name || name.length > 8) {
      return { success: false, message: '名称不能超过8个字' }
    }
    try {
      const res = await this.callFunction({
        name: 'updateKitchenName',
        data: { kitchenName: name }
      })
      if (res.result?.success) {
        this.globalData.currentUser.kitchenName = name
        return { success: true }
      }
      return { success: false, message: res.result?.message || '更新失败' }
    } catch (e) {
      console.error('update kitchen name error', e)
      return { success: false, message: '更新失败' }
    }
  },
})
