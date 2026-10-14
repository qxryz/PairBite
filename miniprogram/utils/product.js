// 旧菜单记录没有 type 时仍按菜品处理。
const PRODUCT_TYPES = [
  { value: 'food', label: '菜品', icon: '🍽️' },
  { value: 'membership', label: '会员', icon: '🎟️' },
  { value: 'gift', label: '小礼物', icon: '🎁' },
]

function normalizeProductType(type) {
  return PRODUCT_TYPES.some(item => item.value === type) ? type : 'food'
}

function getProductType(type) {
  const value = normalizeProductType(type)
  return PRODUCT_TYPES.find(item => item.value === value)
}

function normalizeProduct(product) {
  const meta = getProductType(product.type)
  const description = typeof product.description === 'string' ? product.description : product.desc || ''
  return { ...product, description, type: meta.value, typeLabel: meta.label, typeIcon: meta.icon }
}

function normalizeCategory(category) {
  const meta = getProductType(category.type)
  return { ...category, type: meta.value, typeLabel: meta.label }
}

function categoriesForType(categories, type) {
  const value = normalizeProductType(type)
  return categories.filter(category => normalizeProductType(category.type) === value)
}

module.exports = {
  PRODUCT_TYPES,
  normalizeProductType,
  getProductType,
  normalizeProduct,
  normalizeCategory,
  categoriesForType,
}
