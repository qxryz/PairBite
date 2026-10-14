# SheWant

SheWant is a modified version of [PairBite](https://github.com/630999Steven/PairBite), built incrementally on the WeChat Mini Program by **630999Steven**. This fork is [qxryz/PairBite](https://github.com/qxryz/PairBite). Original attribution and the [CC BY-NC-SA 4.0](LICENSE) license are retained.

Two people share a menu of food, memberships, and gifts. Select items or submit a wish to the other person, who can accept, reply, and mark it complete. The project does not process payments, purchase products, top up accounts, or redeem memberships.

[中文](README.md)

## Features

- Retains PairBite's invitation codes, partner binding, shared menu, categories, recipe editing, order history, completion photos, and shop naming.
- Adds food, membership, and gift product types, with specifications for memberships and gifts.
- Supports menu orders with notes and a requested date, or a separate wish with a reference link.
- Filters orders by all, created by me, or received. Recipients handle orders; creators can cancel pending orders.
- Provides a local demo when no cloud environment is configured, with requester and recipient identities.
- Can attempt WeChat subscription notifications after real templates are configured.

## Run locally

1. Clone this fork:

   ```bash
   git clone https://github.com/qxryz/PairBite.git
   cd PairBite
   ```

2. Import the **repository root** into [WeChat DevTools](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html). `project.config.json` points to `miniprogram/` for the Mini Program and `cloudfunctions/` for cloud functions.
3. Install the Mini Program's WeUI dependency:

   ```bash
   npm ci --prefix miniprogram
   ```

4. Select **Tools → Build npm** in WeChat DevTools, then compile. The generated `miniprogram/miniprogram_npm/` directory is excluded from source control.
5. Leave `envId` empty in `miniprogram/envList.js` to use the local demo. In Settings, switch between the requester and recipient to try creating, accepting, and completing orders.

The demo uses the cloud function data protocol with `requester` and `receiver` identities. Data stays in the current tool or device's local storage. It does not provide real WeChat binding, cross-device synchronization, or subscription notifications. Once a cloud environment is configured, failed cloud calls show errors and do not fall back to sample data.

This is a native WeChat Mini Program, opened through WeChat DevTools. There is no React website or web development server.

## Deploy to WeChat Cloud Development

Real use by two people requires your own Mini Program AppID, cloud environment, and access to a trial or released version. Check your cloud console for current quotas, plans, and pricing.

### 1. Configure the AppID and environment

- Set your AppID in `project.config.json`.
- Enable or select the matching cloud environment in WeChat DevTools.
- Set `envId` in `miniprogram/envList.js`, preserving the file's export structure.

The AppID and cloud environment must match. A local demo cannot confirm cross-device synchronization or message delivery without a real AppID and environment.

### 2. Create the collections and set permissions

Keep the original four collections and data model:

| Collection | Purpose |
| --- | --- |
| `User` | Users, invitation codes, and binding relationships |
| `DishList` | Shared products and recipes, extended with `type` and `spec` |
| `OrderList` | Product snapshots, wishes, creators, recipients, and status |
| `Category` | Shared categories |

Apply the following custom security rule to **each** collection to deny direct Mini Program client access:

```json
{
  "read": false,
  "write": false
}
```

Cloud functions handle data access. Shared queries and mutations check the authenticated user, reciprocal binding, and `coupleId`. Products are created through `updateCoupleData` with action `add`; orders are created on the server through `manageOrder`. Do not open client access to work around a permission error.

Legacy products without `type` are treated as food; legacy orders without `status` display as pending. Back up existing data and verify it in your own test environment before deployment.

### 3. Deploy every cloud function

Select the cloud environment in WeChat DevTools. For each function below, choose **Upload and Deploy: Install dependencies on cloud (do not upload node_modules)**. The original 10 functions remain, with `manageOrder` added, for 11 functions in total:

| Function | Purpose |
| --- | --- |
| `createUser` | Login and profiles |
| `bindPartner` | Invitation-code binding |
| `unbindPartner` | Unbinding |
| `getCoupleData` | Shared data queries |
| `updateCoupleData` | Product creation and allowed shared updates/deletions |
| `manageCategory` | Categories |
| `updateKitchenName` | Shop naming |
| `sendNotify` | Subscription notifications |
| `getOpenId` | Current user's OpenID |
| `getFileURL` | Temporary cloud file URLs |
| `manageOrder` | Order creation and status transitions |

The server creates product snapshots from the current binding and product records. Submitting the same request ID again does not create a duplicate order. The client cannot choose the creator, recipient, `coupleId`, or initial status.

### 4. Configure subscription messages (optional)

Add actual templates available to your Mini Program in the [WeChat platform](https://mp.weixin.qq.com/). Set the actual template IDs in `notifyTmplIds` in `miniprogram/envList.js`, then configure these environment variables for `sendNotify`:

| Variable | Purpose |
| --- | --- |
| `NOTIFY_TEMPLATE_ID` | New order and product template ID |
| `ORDER_STATUS_TEMPLATE_ID` | Status template ID; defaults to the preceding ID |
| `NOTIFY_TEMPLATE_FIELDS` | JSON string mapping semantic names to template fields |
| `ORDER_STATUS_TEMPLATE_FIELDS` | Status field mapping; defaults to the preceding mapping |

Example mapping:

```json
{"time":"time25","title":"thing31","content":"thing2","remark":"thing11"}
```

These example fields came from the original template. Replace them with your actual template field IDs and types. The client authorization template IDs must match those used by the cloud function. Placeholder IDs do not work.

The recipient must authorize the template and have available subscription quota. Missing templates skip sending. A send failure does not undo a created order or status update. Each notification state is attempted at most once per order; delivery is not guaranteed and is not automatically retried.

### 5. Verify with two people and publish

Configure trial membership and version access according to the current WeChat platform requirements. Two real users should set profiles and bind through an invitation code, then verify:

1. One user adds food, a membership, or a gift; the other can refresh and view it.
2. One user creates a menu order or a wish; the other can view the received order.
3. The recipient accepts, replies, and completes the order; the creator sees the status changes.
4. Creators can only cancel pending orders, and users cannot access another pair's data.
5. If notifications are enabled, verify authorization, template fields, and actual delivery.

## Order status

| Status | Available actions |
| --- | --- |
| `pending` | Recipient accepts; creator cancels |
| `accepted` | Recipient marks complete |
| `completed` | View the record |
| `cancelled` | View the record |

These statuses record progress between two people. They do not confirm a payment, purchase, or account top-up.

## Structure

```text
miniprogram/
  app.js / app.json / app.wxss   Global logic, routes, and styles
  envList.js                    Cloud environment configuration
  components/bind-guard/        Binding reminder
  utils/                        Products, recipes, and local demo
  pages/                        11 original pages and the new Wish page
cloudfunctions/                 10 original functions and manageOrder
scripts/check-miniprogram.js    Source checks
tests/                          Local logic and permission tests
project.config.json             WeChat DevTools project configuration
LICENSE                         CC BY-NC-SA 4.0
```

The original pages are `MainPage`, `Dishes`, `DishAdd`, `DishDetail`, `RecipeEdit`, `Order`, `OrderHistory`, `OrderDetail`, `Settings`, `Bind`, and `CategoryManage`.

## Checks

Using a Node.js version with `node:test` support, run from the repository root:

```bash
npm run check
npm test
```

The root scripts use only Node.js built-in modules. Static checks cover source JavaScript and JSON, page files, WXML tags, interpolation, directives and event handlers, local references, routes, and resource paths. They skip `node_modules` and generated `miniprogram_npm` files. Local checks do not replace WeChat DevTools compilation, device testing, or verification against a real cloud environment.

## Attribution and license

Original project: [630999Steven/PairBite](https://github.com/630999Steven/PairBite), by **630999Steven**. Modified version: [qxryz/PairBite](https://github.com/qxryz/PairBite).

This project remains under [CC BY-NC-SA 4.0](LICENSE): credit the original author, use it only for noncommercial purposes, and share adaptations under the same license. Exclude personal credentials, local configuration, generated files, and development notes before contributing.
