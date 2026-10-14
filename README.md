# SheWant 心愿小店

SheWant 是 [PairBite](https://github.com/630999Steven/PairBite) 的修改版，基于原作者 **630999Steven** 的微信小程序增量开发。本修改版仓库为 [qxryz/PairBite](https://github.com/qxryz/PairBite)，保留原作者署名及 [CC BY-NC-SA 4.0](LICENSE) 协议。

两人共享菜品、会员和礼物菜单，选择商品或填写心愿后向对方下单。接单方可以接单、回复和标记完成。项目不包含支付、自动购买、充值或会员兑换功能。

[English](README.en-US.md)

## 功能

- 保留 PairBite 的邀请码绑定、共享菜单、分类、菜谱编辑、订单记录、成果照片和店铺命名。
- 菜品、会员、小礼物三种商品类型，会员和礼物支持填写规格。
- 从菜单选择商品下单，支持备注和希望日期；也可以单独填写心愿及参考链接。
- 按「全部 / 我下的 / 收到的」查看订单，接单方处理订单，下单方取消待处理订单。
- 未配置云环境时提供本机体验，可以切换下单方与接单方。
- 配置真实微信订阅消息模板后，可尝试发送新订单和状态通知。

## 本机运行

1. 克隆本修改版仓库：

   ```bash
   git clone https://github.com/qxryz/PairBite.git
   cd PairBite
   ```

2. 用 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html) 导入**仓库根目录**。`project.config.json` 已将小程序目录配置为 `miniprogram/`，云函数目录配置为 `cloudfunctions/`。
3. 安装小程序的 WeUI 依赖：

   ```bash
   npm ci --prefix miniprogram
   ```

4. 在微信开发者工具中执行「工具 → 构建 npm」，然后编译。`miniprogram/miniprogram_npm/` 是生成目录，不提交到仓库。
5. `miniprogram/envList.js` 的 `envId` 留空时进入本机体验。在「设置」切换「下单方 / 接单方」，依次体验下单、接单和完成。

本机体验沿用云函数的数据协议，示例身份为 `requester` 和 `receiver`，数据只保存在当前工具或设备的本地存储中。它不进行真实微信绑定、跨设备同步或订阅通知。配置了云环境后，云调用失败会显示错误，不会切换成本机示例数据。

这是原生微信小程序，运行入口是微信开发者工具；仓库没有 React 网站或 Web 开发服务器。

## 部署微信云开发

实际双人使用需要你自己的小程序 AppID、云开发环境和体验版或正式版访问权限。云开发资源额度、套餐和价格以你的控制台为准。

### 1. 配置 AppID 与环境

- 在 `project.config.json` 中将 `appid` 替换为你的小程序 AppID。
- 在微信开发者工具中开通或选择对应的云开发环境。
- 将 `miniprogram/envList.js` 中的 `envId` 填为该环境 ID；保留文件原有导出结构。

AppID 与云环境必须相互匹配。没有真实 AppID 和云环境时，不能据本机体验确认跨设备同步或微信通知已经可用。

### 2. 创建数据库集合并配置权限

沿用原项目的四个集合，不需要迁移或替换为新的数据模型：

| 集合 | 用途 |
| --- | --- |
| `User` | 用户、邀请码与绑定关系 |
| `DishList` | 共享商品及菜谱，新增 `type`、`spec` 字段 |
| `OrderList` | 商品快照、心愿、下单人、接单人及处理状态 |
| `Category` | 双方共享的分类 |

为这四个集合分别设置自定义安全规则，禁止小程序客户端直接读写：

```json
{
  "read": false,
  "write": false
}
```

数据通过云函数访问。共享查询和更新会校验当前登录用户、双方绑定关系及 `coupleId`，商品由 `updateCoupleData` 的 `add` 操作创建，订单由 `manageOrder` 在服务端创建。请勿为了消除权限错误而开放集合的客户端读写权限。

旧商品没有 `type` 时按菜品处理；旧订单没有 `status` 时按待处理显示。保留原有数据前，请先备份并在自己的测试环境验证。

### 3. 部署全部云函数

在微信开发者工具中选择云环境，对以下每个目录执行「上传并部署：云端安装依赖（不上传 node_modules）」。保留原来的 10 个云函数，并新增 `manageOrder`，共 11 个：

| 云函数 | 功能 |
| --- | --- |
| `createUser` | 用户登录与资料 |
| `bindPartner` | 邀请码绑定 |
| `unbindPartner` | 解除绑定 |
| `getCoupleData` | 查询共享数据 |
| `updateCoupleData` | 创建商品、更新和删除允许的共享字段 |
| `manageCategory` | 分类管理 |
| `updateKitchenName` | 店铺命名 |
| `sendNotify` | 微信订阅消息 |
| `getOpenId` | 获取当前用户 OpenID |
| `getFileURL` | 云文件临时链接 |
| `manageOrder` | 创建订单及校验订单状态变更 |

创建订单时，服务端读取当前绑定关系、商品和规格生成快照。重复提交相同请求编号不会重复创建订单。客户端不能自行指定下单人、收件人、`coupleId` 或初始状态。

### 4. 配置订阅消息（可选）

在[微信公众平台](https://mp.weixin.qq.com/)为你的小程序申请实际可用的订阅模板，将实际模板 ID 配置到 `miniprogram/envList.js` 的 `notifyTmplIds`，并为 `sendNotify` 配置云函数环境变量：

| 环境变量 | 用途 |
| --- | --- |
| `NOTIFY_TEMPLATE_ID` | 新订单、新商品的模板 ID |
| `ORDER_STATUS_TEMPLATE_ID` | 状态变更模板 ID；未设置时使用前者 |
| `NOTIFY_TEMPLATE_FIELDS` | 模板字段映射的 JSON 字符串 |
| `ORDER_STATUS_TEMPLATE_FIELDS` | 状态模板字段映射；未设置时使用前者 |

字段映射示例：

```json
{"time":"time25","title":"thing31","content":"thing2","remark":"thing11"}
```

示例字段来自原项目模板，必须按你实际模板中的字段 ID 和类型修改。客户端申请授权所用的模板 ID 也须与云端发送所用的模板一致；占位 ID 无效。

收件人需要事先授权并具有可用订阅额度。未配置真实模板时会跳过发送；发送失败不撤销已创建的订单或已提交的状态。每个订单的每种通知状态最多尝试一次，不保证消息送达，也不会自动重试。

### 5. 双人验证与发布

按微信公众平台当前要求配置体验成员和体验版访问权限。两名真实用户分别打开小程序、设置资料并用邀请码绑定，然后验证：

1. 一方添加菜品、会员或礼物，另一方能够刷新查看。
2. 一方从菜单下单或填写心愿，另一方能够看到收到的订单。
3. 接单方接单、回复并标记完成，下单方能够看到状态变化。
4. 下单方只能取消待处理订单；双方不能操作其他绑定关系的数据。
5. 如启用通知，分别验证授权、模板字段和实际送达结果。

## 订单状态

| 当前状态 | 可进行的操作 |
| --- | --- |
| 待处理 `pending` | 接单方接单；下单方取消 |
| 进行中 `accepted` | 接单方标记完成 |
| 已完成 `completed` | 查看记录 |
| 已取消 `cancelled` | 查看记录 |

这些操作仅记录双方的处理进度，不代表已付款、已购买或已经充值。

## 项目结构

```text
miniprogram/
  app.js / app.json / app.wxss   全局逻辑、路由和样式
  envList.js                    云环境配置
  components/bind-guard/        绑定提醒
  utils/                        商品、菜谱和本机体验逻辑
  pages/                        原 11 个页面和新增 Wish 心愿页
cloudfunctions/                 原 10 个云函数和新增 manageOrder
scripts/check-miniprogram.js    源码静态检查
tests/                          本地逻辑与权限测试
project.config.json             微信开发者工具项目配置
LICENSE                         CC BY-NC-SA 4.0
```

原页面为 `MainPage`、`Dishes`、`DishAdd`、`DishDetail`、`RecipeEdit`、`Order`、`OrderHistory`、`OrderDetail`、`Settings`、`Bind`、`CategoryManage`。

## 检查

使用支持 `node:test` 的 Node.js 版本，在仓库根目录执行：

```bash
npm run check
npm test
```

根目录脚本只使用 Node.js 内置模块。静态检查覆盖源码 JS/JSON、页面文件、WXML 标签与插值、指令和事件处理函数、本地引用、页面路由及资源路径，跳过 `node_modules` 和生成的 `miniprogram_npm`。本地检查不能替代微信开发者工具编译、真机验证与真实云环境联调。

## 来源与许可

原项目：[630999Steven/PairBite](https://github.com/630999Steven/PairBite)，原作者：**630999Steven**。本修改版：[qxryz/PairBite](https://github.com/qxryz/PairBite)。

本项目继续使用 [CC BY-NC-SA 4.0](LICENSE)：须保留署名、禁止商业用途，修改后分享须使用相同协议。提交代码前请排除个人密钥、本地配置、生成文件及开发过程文档。
