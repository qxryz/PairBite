const cloud = require('wx-server-sdk')
const crypto = require('crypto')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 保留原有分类和旧菜品的 category 值，升级时不覆盖用户的名称、图标。
const DEFAULT_CATEGORIES = [
  { legacyId: 'meat', name: '荤菜', icon: '🥩', sort: 0, type: 'food' },
  { legacyId: 'vegetable', name: '素菜', icon: '🥬', sort: 1, type: 'food' },
  { legacyId: 'soup', name: '汤类', icon: '🍲', sort: 2, type: 'food' },
  { legacyId: 'rice', name: '主食', icon: '🍚', sort: 3, type: 'food' },
  { legacyId: 'noodle', name: '面食', icon: '🍜', sort: 4, type: 'food' },
  { legacyId: 'cold', name: '凉菜', icon: '🥗', sort: 5, type: 'food' },
  { legacyId: 'dessert', name: '甜点', icon: '🍰', sort: 6, type: 'food' },
  { legacyId: 'drink', name: '饮品', icon: '🥤', sort: 7, type: 'food' },
]
const EXTRA_CATEGORIES = [
  { key: 'membership', name: '会员', icon: '🎫', type: 'membership' },
  { key: 'gift', name: '小礼物', icon: '🎁', type: 'gift' },
]
const CATEGORY_TYPES = ['food', 'membership', 'gift']
const PAGE_SIZE = 50
const MAX_CATEGORIES = 40
const MAX_REORDER_ITEMS = 49

function fail(message) {
  const error = new Error(message)
  error.isValidationError = true
  throw error
}

function validId(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128
}

function categoryType(category) {
  return category.type || 'food'
}

function validateFields(data, fallbackType) {
  if (typeof data.name !== 'string' || !data.name.trim() || [...data.name.trim()].length > 20 || /[\u0000-\u001f]/.test(data.name)) {
    fail('分类名称需为1至20个字')
  }
  if (typeof data.icon !== 'string' || !data.icon.trim() || data.icon.length > 32 || /[\u0000-\u001f]/.test(data.icon)) {
    fail('请选择有效的分类图标')
  }
  const type = data.type === undefined ? fallbackType : data.type
  if (!CATEGORY_TYPES.includes(type)) fail('分类类型不正确')
  return { name: data.name.trim(), icon: data.icon.trim(), type }
}

async function getDocument(collection, id) {
  try {
    const res = await collection.doc(id).get()
    return res.data || null
  } catch (error) {
    if (/document.*(?:not exist|does not exist|not found)|文档不存在/i.test(error.message || '')) return null
    throw error
  }
}

async function ownedCategory(database, id, coupleId) {
  const category = await getDocument(database.collection('Category'), id)
  if (!category || category.coupleId !== coupleId) fail('分类不存在或无权操作')
  return category
}

async function requireCurrentSpace(transaction, currentOpenid, coupleId) {
  const user = await getDocument(transaction.collection('User'), currentOpenid)
  if (!user || user.coupleId !== coupleId || user.bindStatus !== 'bound' || !validId(user.partnerId) || user.partnerId === currentOpenid) {
    fail('绑定状态已变化，请刷新后重试')
  }
  const partner = await getDocument(transaction.collection('User'), user.partnerId)
  if (!partner || partner.partnerId !== currentOpenid || partner.coupleId !== coupleId || partner.bindStatus !== 'bound') {
    fail('绑定状态已变化，请刷新后重试')
  }
}

async function listCategories(coupleId) {
  const categories = []
  while (true) {
    const res = await db.collection('Category').where({ coupleId })
      .orderBy('sort', 'asc').skip(categories.length).limit(PAGE_SIZE).get()
    categories.push(...res.data)
    if (res.data.length < PAGE_SIZE) return categories
  }
}

async function transactionResult(callback) {
  const result = await db.runTransaction(callback)
  return result && Object.prototype.hasOwnProperty.call(result, 'result') ? result.result : result
}

function defaultId(coupleId, key) {
  return 'category_' + crypto.createHash('sha256').update(`${coupleId}:${key}`).digest('hex').slice(0, 40)
}

// 旧版本没有存 legacyId：先认已有标记和原名称，再按原 sort 识别改过名称的分类。
function legacyMappings(categories) {
  const food = categories.filter(category => categoryType(category) === 'food')
  const used = new Set()
  const mappings = []
  for (const cat of DEFAULT_CATEGORIES) {
    const existing = food.find(item => !used.has(item._id) && item.legacyId === cat.legacyId)
      || food.find(item => !used.has(item._id) && !item.legacyId && item.name === cat.name)
    if (existing) {
      used.add(existing._id)
      mappings.push({ legacyId: cat.legacyId, _id: existing._id })
    }
  }
  for (const cat of DEFAULT_CATEGORIES) {
    if (mappings.some(item => item.legacyId === cat.legacyId)) continue
    const existing = food.find(item => !used.has(item._id) && !item.legacyId && item.sort === cat.sort)
    if (existing) {
      used.add(existing._id)
      mappings.push({ legacyId: cat.legacyId, _id: existing._id })
    }
  }
  return mappings
}

async function requireAnotherCategory(transaction, categories, source, coupleId) {
  const candidates = categories.filter(item => item._id !== source._id && categoryType(item) === categoryType(source))
  for (const item of candidates.slice(0, MAX_CATEGORIES)) {
    const current = await getDocument(transaction.collection('Category'), item._id)
    if (current && current.coupleId === coupleId && categoryType(current) === categoryType(source)) return
  }
  fail('每种类型至少保留一个分类')
}

async function countDishes(coupleId, categoryId) {
  const res = await db.collection('DishList').where({ coupleId, category: categoryId }).count()
  return res.total
}

exports.main = async (event = {}, context) => {
  try {
    if (!event || typeof event !== 'object' || Array.isArray(event)) fail('请求参数不正确')
    const { action } = event
    const data = event.data === undefined ? {} : event.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail('请求参数不正确')
    const currentOpenid = cloud.getWXContext().OPENID
    if (!validId(currentOpenid)) fail('请先登录')
    const userRes = await db.collection('User').doc(currentOpenid).get()
    const coupleId = userRes.data?.coupleId
    if (!validId(coupleId) || userRes.data.bindStatus !== 'bound' || !validId(userRes.data.partnerId) || userRes.data.partnerId === currentOpenid) {
      return { success: false, message: '未绑定伴侣' }
    }
    await requireCurrentSpace(db, currentOpenid, coupleId)

    const col = db.collection('Category')
    const dishCol = db.collection('DishList')

    switch (action) {
      case 'init': {
        const defaults = DEFAULT_CATEGORIES.concat(EXTRA_CATEGORIES)
        const initialized = await transactionResult(async transaction => {
          await requireCurrentSpace(transaction, currentOpenid, coupleId)
          const existing = await listCategories(coupleId)
          // 只锁迁移候选、各类型代表和固定默认ID，旧空间分类很多时也不会超出事务操作数。
          const candidates = legacyMappings(existing).map(item => item._id)
          for (const type of CATEGORY_TYPES) {
            const representative = existing.find(item => categoryType(item) === type)
            if (representative) candidates.push(representative._id)
          }
          const ids = [...new Set(candidates.concat(
            defaults.map(item => defaultId(coupleId, item.legacyId || item.key))
          ))]
          const current = []
          for (const id of ids) {
            const item = await getDocument(transaction.collection('Category'), id)
            if (item && item.coupleId !== coupleId) fail('分类初始化失败')
            if (item) current.push(item)
          }
          const wasEmpty = current.length === 0
          // 已有空间保留原分类，包括用户的重命名和删除；没有菜品分类时才补原8类。
          if (!current.some(item => categoryType(item) === 'food')) {
            for (const cat of DEFAULT_CATEGORIES) {
              const id = defaultId(coupleId, cat.legacyId)
              if (current.some(item => item._id === id)) continue
              const record = { ...cat, coupleId, _openid: currentOpenid, createTime: db.serverDate() }
              await transaction.collection('Category').doc(id).set({ data: record })
              current.push({ ...record, _id: id })
            }
          }
          let sort = existing.concat(current).reduce((max, item) => Math.max(max, Number.isFinite(item.sort) ? item.sort : -1), -1) + 1
          for (const cat of EXTRA_CATEGORIES) {
            if (current.some(item => categoryType(item) === cat.type)) continue
            const id = defaultId(coupleId, cat.key)
            if (current.some(item => item._id === id)) fail('分类类型冲突，请刷新后重试')
            const record = { name: cat.name, icon: cat.icon, type: cat.type, sort: sort++, coupleId, _openid: currentOpenid, createTime: db.serverDate() }
            await transaction.collection('Category').doc(id).set({ data: record })
            current.push({ ...record, _id: id })
          }
          const mappings = legacyMappings(current)
          for (const mapping of mappings) {
            const category = current.find(item => item._id === mapping._id)
            if (category.legacyId !== mapping.legacyId || !category.type) {
              await transaction.collection('Category').doc(mapping._id).update({
                data: { legacyId: mapping.legacyId, type: 'food' }
              })
            }
          }
          return { wasEmpty, mappings }
        })
        // 旧菜品迁移可重试，每次只更新仍属于当前空间且仍使用旧值的记录。
        for (const mapping of initialized.mappings) {
          while (true) {
            const dishes = await dishCol.where({ coupleId, category: mapping.legacyId }).limit(20).get()
            if (!dishes.data.length) break
            for (const dish of dishes.data) {
              await transactionResult(async transaction => {
                await requireCurrentSpace(transaction, currentOpenid, coupleId)
                const category = await ownedCategory(transaction, mapping._id, coupleId)
                if (categoryType(category) !== 'food') fail('分类类型已变化，请刷新后重试')
                const current = await getDocument(transaction.collection('DishList'), dish._id)
                if (!current || current.coupleId !== coupleId || current.category !== mapping.legacyId) return
                await transaction.collection('DishList').doc(dish._id).update({ data: { category: mapping._id, type: 'food' } })
                await transaction.collection('Category').doc(mapping._id).update({ data: { mutationVersion: db.command.inc(1) } })
              })
            }
          }
        }
        return { success: true, message: initialized.wasEmpty ? '初始化完成' : '已初始化' }
      }

      case 'list': {
        const categories = await listCategories(coupleId)
        return { success: true, data: categories.map(category => ({ ...category, type: categoryType(category) })) }
      }

      case 'add': {
        const fields = validateFields(data, 'food')
        const addRes = await transactionResult(async transaction => {
          await requireCurrentSpace(transaction, currentOpenid, coupleId)
          const categories = await listCategories(coupleId)
          if (categories.length >= MAX_CATEGORIES) fail(`最多添加${MAX_CATEGORIES}个分类`)
          if (!categories.length) fail('请先初始化分类')
          // 两位成员新增分类时锁同一条现有分类，重试后重新计数，避免并发突破上限。
          const guard = categories.slice().sort((a, b) => a._id.localeCompare(b._id))[0]
          await ownedCategory(transaction, guard._id, coupleId)
          const count = await col.where({ coupleId }).count()
          if (count.total >= MAX_CATEGORIES) fail(`最多添加${MAX_CATEGORIES}个分类`)
          const maxSort = categories.reduce((max, item) => Math.max(max, Number.isFinite(item.sort) ? item.sort : -1), -1) + 1
          await transaction.collection('Category').doc(guard._id).update({ data: { mutationVersion: db.command.inc(1) } })
          return transaction.collection('Category').add({
            data: { ...fields, sort: maxSort, coupleId, _openid: currentOpenid, createTime: db.serverDate() }
          })
        })
        return { success: true, _id: addRes._id }
      }

      case 'update': {
        if (!validId(data._id)) fail('分类参数不正确')
        const categories = await listCategories(coupleId)
        await transactionResult(async transaction => {
          await requireCurrentSpace(transaction, currentOpenid, coupleId)
          const category = await ownedCategory(transaction, data._id, coupleId)
          const fields = validateFields(data, categoryType(category))
          if (fields.type !== categoryType(category)) {
            if (await countDishes(coupleId, data._id)) fail('分类中有商品，不能更改类型')
            await requireAnotherCategory(transaction, categories, category, coupleId)
          }
          await transaction.collection('Category').doc(data._id).update({ data: { ...fields, mutationVersion: db.command.inc(1) } })
        })
        return { success: true }
      }

      case 'remove': {
        if (!validId(data._id) || (data.transferTo !== undefined && !validId(data.transferTo))) fail('分类参数不正确')
        if (data.transferTo === data._id) fail('请选择其他转移分类')
        const categories = await listCategories(coupleId)
        const validateRemoval = async transaction => {
          await requireCurrentSpace(transaction, currentOpenid, coupleId)
          const source = await ownedCategory(transaction, data._id, coupleId)
          await requireAnotherCategory(transaction, categories, source, coupleId)
          if (data.transferTo) {
            const target = await ownedCategory(transaction, data.transferTo, coupleId)
            if (categoryType(source) !== categoryType(target)) fail('只能转移到同类型分类')
          }
          return source
        }
        await transactionResult(async transaction => {
          await validateRemoval(transaction)
          if (!data.transferTo && await countDishes(coupleId, data._id)) fail('分类中有商品，请先选择转移分类')
        })
        if (data.transferTo) {
          while (true) {
            const dishes = await dishCol.where({ coupleId, category: data._id }).limit(20).get()
            if (!dishes.data.length) break
            for (const dish of dishes.data) {
              await transactionResult(async transaction => {
                await requireCurrentSpace(transaction, currentOpenid, coupleId)
                const source = await ownedCategory(transaction, data._id, coupleId)
                const target = await ownedCategory(transaction, data.transferTo, coupleId)
                if (categoryType(source) !== categoryType(target)) fail('只能转移到同类型分类')
                const current = await getDocument(transaction.collection('DishList'), dish._id)
                if (!current || current.coupleId !== coupleId || current.category !== data._id) return
                await transaction.collection('DishList').doc(dish._id).update({ data: { category: data.transferTo, type: categoryType(target) } })
                await transaction.collection('Category').doc(data._id).update({ data: { mutationVersion: db.command.inc(1) } })
                await transaction.collection('Category').doc(data.transferTo).update({ data: { mutationVersion: db.command.inc(1) } })
              })
            }
          }
        }
        await transactionResult(async transaction => {
          await validateRemoval(transaction)
          if (await countDishes(coupleId, data._id)) fail('分类内容已变化，请重新操作')
          await transaction.collection('Category').doc(data._id).remove()
        })
        return { success: true }
      }

      case 'reorder': {
        if (!Array.isArray(data.orders) || !data.orders.length || data.orders.length > MAX_REORDER_ITEMS) fail('排序参数不正确')
        const ids = new Set()
        for (const item of data.orders) {
          if (!item || !validId(item._id) || ids.has(item._id) || !Number.isSafeInteger(item.sort) || item.sort < 0 || item.sort > 100000) fail('排序参数不正确')
          ids.add(item._id)
        }
        await transactionResult(async transaction => {
          await requireCurrentSpace(transaction, currentOpenid, coupleId)
          // 全部校验通过后再写入，避免跨空间或部分排序。
          for (const item of data.orders) await ownedCategory(transaction, item._id, coupleId)
          for (const item of data.orders) await transaction.collection('Category').doc(item._id).update({ data: { sort: item.sort } })
        })
        return { success: true }
      }

      case 'countDishes': {
        if (!validId(data._id)) fail('分类参数不正确')
        await ownedCategory(db, data._id, coupleId)
        return { success: true, count: await countDishes(coupleId, data._id) }
      }

      default:
        return { success: false, message: '不支持的操作' }
    }
  } catch (e) {
    if (e.isValidationError) return { success: false, message: e.message }
    console.error('manageCategory error', e)
    return { success: false, message: '操作失败', error: e.message }
  }
}
