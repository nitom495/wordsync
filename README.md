# 同频 · WordSync

2–5 人联机文字小游戏：各自提交词语，统一揭晓，逐轮靠拢，直到所有人想到同一个词。页面使用原生 HTML、CSS、JavaScript 和 Vite；Firebase 匿名登录与 Firestore 负责多人同步。

## 本地启动

需要 Node.js 24 和 pnpm 11。复制 `.env.example` 为 `.env.local`，填入 Firebase 控制台中 Web 应用的配置：

```text
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_APP_ID=...
```

在 Firebase 项目中启用 **Authentication → Anonymous** 和 **Cloud Firestore**，保持 **Spark 免费计划**。然后运行：

```sh
pnpm install
pnpm dev
```

所有 `VITE_` 配置都会进入公开的浏览器代码。Firebase Web API key 是项目标识，不作为保密凭据；数据访问由 `firestore.rules` 限制。不要将服务账号私钥放入本项目。

## 安全规则与测试

在 Firebase CLI 登录后部署规则：

```sh
firebase deploy --only firestore:rules --project <你的 Firebase 项目 ID>
```

本地规则模拟器需要 Java 21。运行：

```sh
pnpm test
pnpm test:rules
pnpm build
```

可选的完整本地联机测试：先在一个终端运行 `firebase emulators:start --project demo-wordsync --only auth,firestore`，再在另一个终端设置 `VITE_USE_EMULATORS=true` 并运行 `pnpm dev`。此模式使用本机模拟器，不会触碰真实 Firebase 数据。

## GitHub Pages 发布

1. 将本目录推送到一个**公开** GitHub 仓库的 `main` 分支。
2. 在仓库 **Settings → Secrets and variables → Actions → Variables** 添加与 `.env.example` 同名的四个变量。
3. 在 **Settings → Pages** 将来源设为 **GitHub Actions**。
4. 推送后，`.github/workflows/pages.yml` 构建并发布 `dist`。检查 Actions 成功状态与 Pages URL。
5. 用手机和电脑各打开一次公开网址，创建房间并通过 `?room=房间码` 链接加入，完成一次跨设备游戏。

免费 GitHub Pages 需要公开仓库。国内玩家需要能访问 Firebase 服务的网络连接。房主意外关闭页面后，可用原浏览器重新打开邀请链接；第一版不做自动房主转移。
