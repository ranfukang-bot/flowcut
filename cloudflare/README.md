# FlowCut 自有授权中心

这套部署只把 FlowCut 的授权账号、设备绑定、到期时间和审计记录放到
Cloudflare。Gem、商品库、Gemini / TikTok 登录态、提示词、任务和视频仍然只
保存在每台使用者电脑上。

## 你必须亲自完成的步骤

1. 使用你本人长期控制的邮箱注册 Cloudflare 账户。
2. 在账户中开启两步验证并保存恢复码。
3. 在项目目录执行 `npx wrangler login`，浏览器打开后由你本人登录并授权。
4. 部署完成后，把 `.flowcut-cloudflare` 私密目录和 `backups` 数据库备份保存
   到你本人控制的加密硬盘或密码库。

不要把 Cloudflare 密码、两步验证代码或 API Token 发给开发者或 AI。

## 已自动化的步骤

- `npm run cloudflare:prepare`：生成管理员密码、许可证签名密钥和恢复资料。
- `npm run cloudflare:deploy`：创建或复用 D1 数据库、初始化表、构建并发布
  Worker、上传秘密值并执行健康检查。
- `npm run cloudflare:backup`：导出一份可恢复的 D1 SQL 数据库备份。

## 部署顺序

```powershell
npm run cloudflare:prepare
npx wrangler login
npm run cloudflare:deploy
npm run cloudflare:backup
```

部署脚本会在 `.flowcut-cloudflare/desktop-distribution.json` 中生成桌面版需要
使用的授权地址和验签公钥。它们还需要写入桌面客户端并重新打包，不能继续
分发现有依赖 ChatGPT Sites 的安装包。

## 日常维护

- 新建、停用账号和解绑设备：打开部署地址，使用恢复资料中的管理员账号登录。
- 每次大批量修改授权账号后执行一次 `npm run cloudflare:backup`。
- 每月至少备份一次，并保留最近三份。
- 将来换电脑或换维护者时，同时交接源码接管包、`.flowcut-cloudflare`
  私密恢复资料和最近的数据库备份。

## 灾难恢复

恢复时必须使用原来的许可证私钥。只恢复数据库但换掉私钥，会导致已安装客户
端保存的离线许可证无法验签。正确流程是：在新 Cloudflare 账户创建空 D1，
导入最近的 SQL 备份，重新上传原恢复资料中的三个 Secret，然后部署同一版本。
如果 workers.dev 地址变化，还需要更新桌面客户端；以后绑定自己的域名可以
避免这一点。
