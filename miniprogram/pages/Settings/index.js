const app = getApp()

Page({
  data: {
    appName: '',
    userName: '',
    userAvatar: '',
    partnerName: '',
    partnerAvatar: '',
    isBound: false,
    dishCount: 0,
    orderCount: 0,
    showEditModal: false,
    tempNickname: '',
    tempAvatarUrl: '',
    saving: false,
    isDemo: false,
    demoIdentity: '',
    version: '',
  },

  onLoad(options) {
    if (options.editProfile) {
      this._autoEditProfile = true
    }
  },

  async onShow() {
    await this.loadUserInfo()
    this.loadAppInfo()
    await this.loadStats()
    app.setKitchenTitle()
    if (this._autoEditProfile) {
      this._autoEditProfile = false
      this.openEditProfile()
    }
  },

  // 加载用户信息
  async loadUserInfo() {
    const { currentUser, partner } = await app.loadUserInfo()
    this.setData({
      userName: currentUser?.nickname || '未设置',
      userAvatar: currentUser?.avatarUrl || '',
      partnerName: partner?.nickname || '',
      partnerAvatar: partner?.avatarUrl || '',
      isBound: app.isBound()
    })
  },

  // 加载应用信息
  loadAppInfo() {
    this.setData({
      appName: app.getKitchenName(),
      isDemo: !!app.globalData.isDemo,
      demoIdentity: app.getDemoIdentity(),
      version: app.globalData.version
    })
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

  // 跳转到绑定页面
  goToBind() {
    wx.navigateTo({ url: '/pages/Bind/index' })
  },

  // 打开编辑个人信息弹窗
  openEditProfile() {
    this.setData({
      showEditModal: true,
      tempNickname: this.data.userName === '未设置' ? '' : this.data.userName,
      tempAvatarUrl: ''
    })
  },

  // 关闭编辑弹窗
  closeEditModal() {
    this.setData({ showEditModal: false })
  },

  // 阻止冒泡
  preventClose() {},

  // 选择头像
  onChooseAvatar(e) {
    this.setData({ tempAvatarUrl: e.detail.avatarUrl })
  },

  // 输入昵称
  onNicknameInput(e) {
    this.setData({ tempNickname: e.detail.value })
  },

  // 保存个人信息
  async saveProfile() {
    const { tempNickname, tempAvatarUrl, userAvatar, saving } = this.data
    if (saving) return

    const nickname = tempNickname.trim()
    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    wx.showLoading({ title: '保存中...', mask: true })

    try {
      let avatarUrl = userAvatar
      // 如果选择了新头像，上传到云存储
      if (tempAvatarUrl) {
        const cloudPath = `avatars/${Date.now()}-${Math.random().toString(36).substr(2)}.jpg`
        const uploadRes = await app.uploadFile({
          cloudPath,
          filePath: tempAvatarUrl
        })
        avatarUrl = uploadRes.fileID
      }

      // 调用云函数更新用户信息
      const result = await app.callFunction({
        name: 'createUser',
        data: { nickname, avatarUrl }
      })

      if (!result.result?.success) throw new Error(result.result?.message || '保存失败')

      // 刷新用户信息
      await app.loadUserInfo(true)
      await this.loadUserInfo()

      wx.hideLoading()
      this.setData({ showEditModal: false })
      wx.showToast({ title: '保存成功', icon: 'success' })
    } catch (e) {
      wx.hideLoading()
      console.error('save profile error', e)
      wx.showToast({ title: '保存失败', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  async switchDemoIdentity(e) {
    if (!this.data.isDemo) return
    try {
      await app.setDemoIdentity(e.currentTarget.dataset.identity)
      await this.loadUserInfo()
      this.loadAppInfo()
      await this.loadStats()
      wx.showToast({ title: '已切换体验身份', icon: 'none' })
    } catch (error) {
      wx.showToast({ title: error.message || '切换失败', icon: 'none' })
    }
  },

  // 授权给当前微信账号；双方需要分别开启自己的提醒。
  async requestNotifyPermission() {
    try {
      const result = await app.requestSubscribeMessage({ tmplIds: app.globalData.notifyTmplIds })
      if (result.skipped) {
        wx.showToast({ title: this.data.isDemo ? '本机体验不发送微信消息' : '订单提醒尚未配置', icon: 'none' })
      } else {
        const accepted = app.globalData.notifyTmplIds.some(id => result[id] === 'accept')
        wx.showToast({ title: accepted ? '已允许订单提醒' : '未开启订单提醒', icon: 'none' })
      }
    } catch (error) {
      wx.showToast({ title: '暂时无法开启提醒', icon: 'none' })
    }
  },

})
