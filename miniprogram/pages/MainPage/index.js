const app = getApp()

Page({
  data: {
    pageLoading: true,
    startupError: '',
    greeting: '你好',
    userName: '',
    userAvatar: '',
    partnerName: '',
    partnerAvatar: '',
    bindDays: 0,
    todayOrder: null,
    dishCount: 0,
    orderCount: 0,
    isDemo: false,
    isBound: false,
    profileComplete: false,
  },

  // 是否已完成首次加载
  hasLoaded: false,

  onLoad(options) {
    this.setGreeting()
    // 如果携带了邀请码参数（从分享链接进入）
    if (options.inviteCode) {
      app.globalData.pendingInviteCode = options.inviteCode
    }
  },

  async onShow() {
    // 首次进入显示 loading，之后直接显示页面
    if (!this.hasLoaded) {
      this.setData({ pageLoading: true })
    }
    if (app.globalData.startupError) {
      this.setData({ startupError: app.globalData.startupError, pageLoading: false })
      return
    }
    // 每次进入首页都强制刷新用户信息，确保绑定状态及时更新
    await app.loadUserInfo(true)
    await this.loadUserInfo()
    this.setData({ isDemo: !!app.globalData.isDemo, startupError: '' })
    app.setKitchenTitle()
    this.setData({ pageLoading: false })
    this.hasLoaded = true
  },

  retryStartup() {
    if (this.data.pageLoading) return
    this.setData({ pageLoading: true, startupError: '' })
    app.initcloud()
    return this.onShow()
  },

  // 加载用户信息
  async loadUserInfo() {
    const { currentUser, partner } = await app.loadUserInfo()
    const isBound = app.isBound()
    const profileComplete = app.isProfileComplete()

    // 计算绑定天数
    let bindDays = 0
    if (isBound && currentUser?.bindTime) {
      const bindTime = new Date(currentUser.bindTime)
      const now = new Date()
      bindDays = Math.floor((now - bindTime) / (1000 * 60 * 60 * 24)) + 1
    }

    this.setData({
      userName: currentUser?.nickname || '',
      userAvatar: currentUser?.avatarUrl || '',
      partnerName: partner?.nickname || '',
      partnerAvatar: partner?.avatarUrl || '',
      bindDays,
      isBound,
      profileComplete
    })

    // 已绑定，加载其他数据
    if (isBound) {
      await Promise.all([
        this.loadTodayOrder(),
        this.loadStats()
      ])
    }
  },

  // 设置问候语
  setGreeting() {
    const hour = new Date().getHours()
    let greeting = '你好'
    if (hour < 6) greeting = '夜深了'
    else if (hour < 9) greeting = '早上好'
    else if (hour < 12) greeting = '上午好'
    else if (hour < 14) greeting = '中午好'
    else if (hour < 18) greeting = '下午好'
    else if (hour < 22) greeting = '晚上好'
    else greeting = '夜深了'
    this.setData({ greeting })
  },

  // 加载今日点菜
  async loadTodayOrder() {
    try {
      const res = await app.callFunction({
        name: 'getCoupleData',
        data: {
          collection: app.globalData.collectionOrderList,
          todayOnly: true,
          orderBy: 'createTime',
          order: 'desc',
          limit: 1
        }
      })

      if (res.result?.success && res.result.data?.length > 0) {
        const order = res.result.data[0]
        const creatorName = app.getDisplayName(order._openid)
        this.setData({
          todayOrder: {
            ...order,
            creatorName,
            statusText: ({ pending: '待接单', accepted: '进行中', completed: '已完成', cancelled: '已取消' })[order.status || 'pending'],
            timeText: this.formatTime(order.createTime)
          }
        })
      } else {
        this.setData({ todayOrder: null })
      }
    } catch (e) {
      console.error('load today order error', e)
    }
  },

  // 加载统计数据
  async loadStats() {
    try {
      const [dishRes, orderRes] = await Promise.all([
        app.callFunction({
          name: 'getCoupleData',
          data: { collection: app.globalData.collectionDishList, countOnly: true }
        }),
        app.callFunction({
          name: 'getCoupleData',
          data: { collection: app.globalData.collectionOrderList, countOnly: true }
        })
      ])

      this.setData({
        dishCount: dishRes.result?.total || 0,
        orderCount: orderRes.result?.total || 0
      })
    } catch (e) {
      console.error('load stats error', e)
    }
  },

  // 格式化时间
  formatTime(date) {
    if (!date) return ''
    const d = new Date(date)
    const hours = d.getHours().toString().padStart(2, '0')
    const minutes = d.getMinutes().toString().padStart(2, '0')
    return `${hours}:${minutes}`
  },

  goToWish() {
    wx.navigateTo({ url: '/pages/Wish/index' })
  },

  // 跳转到点菜页
  goToOrder() {
    wx.switchTab({ url: '/pages/Order/index' })
  },

  // 跳转到今日订单详情
  goToTodayOrder() {
    if (!this.data.todayOrder?._id) return
    wx.navigateTo({ url: `/pages/OrderDetail/index?id=${this.data.todayOrder._id}` })
  },

  // 跳转到最近点菜记录
  goToRecentOrder() {
    app.requestSubscribeMessage({
      tmplIds: app.globalData.notifyTmplIds,
      complete: async () => {
        try {
          const res = await app.callFunction({
            name: 'getCoupleData',
            data: {
              collection: app.globalData.collectionOrderList,
              orderBy: 'createTime',
              order: 'desc',
              limit: 1
            }
          })
          if (res.result?.success && res.result.data?.length > 0) {
            const order = res.result.data[0]
            wx.navigateTo({ url: `/pages/OrderDetail/index?id=${order._id}` })
          } else {
            wx.switchTab({ url: '/pages/OrderHistory/index' })
          }
        } catch (e) {
          console.error('goToRecentOrder error', e)
          wx.switchTab({ url: '/pages/OrderHistory/index' })
        }
      }
    })
  },

  // 跳转到绑定页
  goToBind() {
    app.requestSubscribeMessage({
      tmplIds: app.globalData.notifyTmplIds,
      complete: () => wx.navigateTo({ url: '/pages/Bind/index' })
    })
  },

  // 跳转到设置页
  goToSettings() {
    app.requestSubscribeMessage({
      tmplIds: app.globalData.notifyTmplIds,
      complete: () => wx.navigateTo({ url: '/pages/Settings/index' })
    })
  },

  // 跳转到类目管理
  goToCategoryManage() {
    app.requestSubscribeMessage({
      tmplIds: app.globalData.notifyTmplIds,
      complete: () => wx.navigateTo({ url: '/pages/CategoryManage/index' })
    })
  },

  // 跳转到设置 profile
  goToSetProfile() {
    wx.navigateTo({ url: '/pages/Settings/index?editProfile=true' })
  },
})
