# PairBite - Couples' Little Kitchen

A WeChat Mini Program designed for couples to help them manage dishes together, decide on daily meals, and record their culinary life.

Based on WeChat Cloud Development (CloudBase), it requires zero servers and zero maintenance—ready to use out of the box. Once deployed, multiple couples can be invited to use it, with data automatically isolated between pairs.

## Feature Overview

- **Partner Binding**: Pair up via invitation codes with automatic two-way data synchronization.
- **Dish Library Management**: Add/edit dishes with support for categories, images, and descriptions.
- **Daily Ordering**: Select dishes from the library to place an "order" with notes; partners receive real-time notifications.
- **Order History**: View all past orders with a "Reorder" feature for quick reuse.
- **Category Management**: Customize dish categories (e.g., Meat, Vegetables, Soup, Staples) with sorting support.
- **Subscription Notifications**: Automatically push WeChat subscription messages to partners after an order is placed.
- **Kitchen Naming**: Customize the name of your little kitchen, synced for both users.

<p>
  <img src="docs/images/c84c40c90154ea6fc2b2adffc075ce52.png" width="180" />
  <img src="docs/images/ced1fa2bb3d78b4be40a7a57a82e0ed0.png" width="180" />
  <img src="docs/images/7b068edcfe92965528ef43c1deda8aea.jpg" width="180" />
  <img src="docs/images/6072e6da3beb9cac110266ec1c5d39bc.jpg" width="180" />
</p>
<p>
  <img src="docs/images/ccd81f7db4ad334c1b7fb087730fe41d.jpg" width="180" />
  <img src="docs/images/a8629d338411f06bd52ba37041055e21.jpg" width="180" />
  <img src="docs/images/026c99529da996b13d8ee25a6ae43887.jpg" width="180" />
  <img src="docs/images/0e23519901d16165b4380d1ac6e40f0e.jpg" width="180" />
</p>

## Tech Stack

| Layer | Technology | Description |
|---|------|------|
| Frontend | WeChat Mini Program Native | WXML + WXSS + JS |
| UI | WeUI | Official WeChat component library |
| Backend | WeChat Cloud Functions | Node.js + wx-server-sdk |
| Database | WeChat Cloud Database | NoSQL Document Database |
| Storage | WeChat Cloud Storage | Dish images |
| Notification | WeChat Subscription Messages | Order/New Dish notifications |

No third-party API dependencies; runs entirely within the WeChat Cloud Development ecosystem.

## Project Structure

```
├── miniprogram/                # Frontend
│   ├── app.js                  # Global logic (User mgmt, bind guard, cloud init)
│   ├── app.json                # Page routing and TabBar config
│   ├── app.wxss                # Global styles
│   ├── envList.js              # Cloud environment config ← Modify this
│   ├── components/
│   │   └── bind-guard/         # Binding status reminder component
│   └── pages/
│       ├── MainPage/           # Home (Couple card, today's order, shortcuts)
│       ├── Order/              # Ordering page (Category selection, cart)
│       ├── Dishes/             # Dish library browsing
│       ├── DishAdd/            # Add/Edit dish
│       ├── DishDetail/         # Dish details
│       ├── OrderHistory/       # Order history
│       ├── OrderDetail/        # Order details
│       ├── Bind/               # Partner binding
│       ├── Settings/           # Personal settings
│       └── CategoryManage/     # Category management
├── cloudfunctions/             # Backend (Cloud Functions)
│   ├── createUser/             # User registration/login, generate invitation code
│   ├── bindPartner/            # Partner pairing
│   ├── unbindPartner/          # Unbinding
│   ├── getCoupleData/          # Query shared couple data
│   ├── updateCoupleData/       # Update/Delete shared data
│   ├── manageCategory/         # Category management (CRUD + default init)
│   ├── updateKitchenName/      # Update kitchen name
│   ├── sendNotify/             # Send subscription notification
│   └── getOpenId/              # Get user OpenID
├── project.config.json         # WeChat DevTools config ← Modify this
└── LICENSE
```

## Deployment Guide

### Prerequisites

- Install [WeChat DevTools](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html).
- Register a WeChat Mini Program account ([Personal account is fine, choose "Other" for category](https://mp.weixin.qq.com/wxopen/waregister?action=step1&source=mpregister&token=&lang=zh_CN)).
- In the Mini Program backend, complete the "Mini Program Information" and "Mini Program Category" sections (choose Tools -> Notepad as the primary category).

### Step 1: Clone Project

```bash
git clone https://github.com/630999Steven/PairBite.git
```

### Step 2: Enable Cloud Development

1. After registering, get your Mini Program AppID from the developer backend.

   ![image-20260426183947448](docs/images/image-20260426183947448.png)

2. Open the project with WeChat DevTools.

   ![image-20260426184308726](docs/images/image-20260426184308726.png)

3. Click the "Cloud Development" (云开发) button in the toolbar.

   ![image-20260426184749860](docs/images/image-20260426184749860.png)

4. Follow the prompts to enable the cloud environment (Free basic plan is sufficient).

5. Note down your **Cloud Environment ID** (e.g., `cloud1-xxxxxxxxxx`).

   ![image-20260426184949404](docs/images/image-20260426184949404.png)

### Step 3: Add Collections

In the Cloud Development platform, go to the Database and add four collections:

1. **User**
2. **DishList**
3. **OrderList**
4. **Category**

![image-20260426203835555](docs/images/image-20260426203835555.png)

### Step 4: Update Configuration

Modify the following two files:

**project.config.json** — Replace with your AppID:

```json
"appid": "YOUR_APP_ID"
```

> Find your AppID in [WeChat Official Accounts Platform](https://mp.weixin.qq.com/) → Development Management → Development Settings.

![image-20260426193206076](docs/images/image-20260426193206076.png)

**miniprogram/envList.js** — Replace with your Cloud Environment ID:

```javascript
const envList = [
  {
    "envId": "YOUR_CLOUD_ENV_ID",
    "alias": "cloud"
  }
]
```

![image-20260426193349260](docs/images/image-20260426193349260.png)

### Step 5: Upload Cloud Functions

In WeChat DevTools:

1. Select your environment.

   ![image-20260426202731252](docs/images/image-20260426202731252.png)

2. For each cloud function in `cloudfunctions/`, right-click and select → "Upload and Deploy: Install dependencies on cloud (do not upload node_modules)".

There are 10 cloud functions to deploy:

| Cloud Function | Purpose |
|--------|------|
| createUser | User registration/login |
| bindPartner | Partner binding |
| unbindPartner | Unbind partner |
| getCoupleData | Query shared data |
| updateCoupleData | Update shared data |
| manageCategory | Category management |
| updateKitchenName | Kitchen naming |
| sendNotify | Message notifications |
| getOpenId | Get OpenID |
| getFileURL | Convert file ID to temporary link |

### Step 6: Configure Subscription Message Templates (Optional)

For order notifications:

1. Log in to [WeChat Official Accounts Platform](https://mp.weixin.qq.com/) → Basic Functions → Subscription Messages → Public Template Library.

   I used "Schedule Reminder" (日程提醒) as the template:

   ![image-20260426200324596](docs/images/image-20260426200324596.png)

2. Search for and select a template containing: Time, Task Name, Reminder Content, and Remarks. Add and submit.

   ![image-20260426200623299](docs/images/image-20260426200623299.png)

3. Go to "My Templates," get the Template ID, and replace the value of `notifyTmplIds` in `miniprogram/app.js`.

> Core functionality will work without this; only push notifications will be disabled. See "FAQ" if messages aren't received.

**Note**: If your template/fields differ from mine, you must manually replace each field's DATA ID in the code.

### Step 7: Invite Experience Members (Required)

Before the app is formally launched, other users must be added as **Experience Members** to access it:

1. [WeChat Official Accounts Platform](https://mp.weixin.qq.com/) → Management → Member Management → Experience Members.
2. Click "Add" and enter the other person's WeChat ID.
3. Once the other person confirms in WeChat, they can scan the experience QR code.

> Personal accounts can add up to 15 experience members, enough for several couples. Data is isolated by `coupleId`.

### Step 8: Upload Code and Deploy

1. Click "Upload" in the top right of WeChat DevTools to upload the code as an "Experience Version" (version number is arbitrary). **No official review/submission is required for this.**

2. In Management -> Version Management, set it as the "Experience Version." Scan the QR code to enter (only members added in Step 7 can enter).

   ![image-20260426202128523](docs/images/image-20260426202128523.png)

## Usage Workflow

1. **User A** opens the app → sets avatar/nickname → goes to "Bind" page to get an invitation code and sends it to User B.
2. **User B** opens the app → sets avatar/nickname → enters User A's code to complete binding.
3. Once bound, both share a dish library and can order food and view records.

## Database Schema

| Collection | Purpose | Data Isolation |
|------|------|---------|
| User | User info, binding relationships | openid |
| DishList | Dish library | coupleId |
| OrderList | Order records | coupleId |
| Category | Dish categories | coupleId |

Data is isolated by `coupleId`, so multiple couples can share one instance of the app without interference.

## Cloud Development Free Tier

| Resource | Free Limit |
|------|---------|
| Database Storage | 2 GB |
| Database Reads | 500k / day |
| Cloud Storage | 5 GB |
| Cloud Function Calls | 400k / month |

Daily use by a couple fits easily within the free tier.

## FAQ

**Q: Do I need two people to use it?**
A: Yes, the dish and ordering features are unlocked only after binding a partner. Single users can only access settings and the binding page.

**Q: How do I change my partner?**
A: Unbind in the settings page, then bind again using a new invitation code. Previous data remains under the old `coupleId`.

**Q: Cloud function deployment error?**
A: Run `npm install` in the cloud function directory before uploading. If it still fails, ensure your Node.js version is $\ge$ 12.

**Q: Not receiving subscription messages?**
A: WeChat subscription authorization is for the **user themselves** to receive messages, not for the partner to send. Therefore, **both partners must authorize** to receive notifications from each other.

Authorization prompts are triggered on the home page, upon submitting orders, after successful binding, and in order details. It is recommended to check "Always keep my choice" and click allow.

**Q: Partner cannot see my uploaded images?**
A: In the free tier, cloud storage permissions cannot be set to "Public Read." The project uses the `getFileURL` cloud function to convert `cloud://` file IDs into temporary links. These links expire in about 2 hours (the frontend refreshes them every 1.5 hours). If you stay on a page for a long time without refreshing, images may expire; simply refresh the page. If you have a paid plan, change cloud storage permissions to "Public Read" and switch to the `premium-storage-version` branch for a cleaner implementation.

## Contribution

Issues and Pull Requests are welcome.

## License

This project is open-sourced under the [CC BY-NC-SA 4.0](LICENSE) license.

- Free to use, modify, and share.
- **Commercial use is prohibited.**
- Modified works must be shared under the same license.
- Original authorship must be credited.
