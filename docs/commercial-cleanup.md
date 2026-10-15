# 商业代码归档与清理

清理前提交：`3f0f978`；已先推送 tag `archive/commercial-before-cleanup`。当前仅保留个人本机版，`.openai/hosting.json` 仍由 Vite 提供本地 D1/R2 绑定，所以保留。

删除 56 个文件，原文件共 12,573 行。以清理前提交为基准，排除文档及 package-lock 后，本次源码/配置差异新增 49 行、删除 13,414 行，净减少 13,365 行。计数包括 CSS、SQL 和旧 schema JSON 快照；不把锁文件变化当作代码减少。

此外清理主页面/Worker 的控制平面分支、Bridge 的 EXECUTION_PERMIT 分支、授权专属 CSS、Vite 环境变量、Drizzle 构建复制、相关脚本和依赖。锁文件中保留依赖的版本未发生变化。

只删除商业专属测试。`rendered-html.test.mjs` 保留业务检查，仅移除对已删除旧 schema/renderer 的引用和断言；账号对话框由现有 Electron 与 HTTP/UI 行为测试覆盖。打包 smoke 改为隔离的个人版启动、沙箱和备份检查。当前 UI 的个人版显示也在真实渲染 smoke 中验证。

删除清单：

```text
app/admin-app.tsx
app/admin/page.tsx
app/api/admin/backup/route.ts
app/api/admin/license/route.ts
app/api/admin/login/route.ts
app/api/admin/logout/route.ts
app/api/control-plane/status/route.ts
app/api/license/lease/route.ts
app/api/license/login/route.ts
app/api/license/logout/route.ts
app/api/license/permit/route.ts
app/api/updates/windows/[asset]/route.ts
app/chatgpt-auth.ts
cloudflare/README.md
cloudflare/license-schema.sql
db/index.ts
db/schema.ts
drizzle.config.ts
drizzle/0000_curved_power_pack.sql
drizzle/0001_salty_scream.sql
drizzle/0002_futuristic_catseye.sql
drizzle/0003_dizzy_nocturne.sql
drizzle/0004_fast_maximus.sql
drizzle/0005_nice_network.sql
drizzle/0006_clear_barracuda.sql
drizzle/0007_solid_bulldozer.sql
drizzle/0008_charming_ezekiel_stane.sql
drizzle/meta/0000_snapshot.json
drizzle/meta/0001_snapshot.json
drizzle/meta/0002_snapshot.json
drizzle/meta/0003_snapshot.json
drizzle/meta/0004_snapshot.json
drizzle/meta/0005_snapshot.json
drizzle/meta/0006_snapshot.json
drizzle/meta/0007_snapshot.json
drizzle/meta/0008_snapshot.json
drizzle/meta/_journal.json
examples/d1/app/api/notes/route.ts
examples/d1/db/schema.ts
gemini-web-workbench/src/index.html
gemini-web-workbench/src/license-client.js
gemini-web-workbench/src/license-distribution.json
gemini-web-workbench/src/renderer.js
gemini-web-workbench/src/styles.css
gemini-web-workbench/src/update-manager.js
gemini-web-workbench/tests/license-distribution.test.js
lib/license.ts
scripts/cloud-permit-smoke.mjs
scripts/cloudflare-backup.mjs
scripts/cloudflare-common.mjs
scripts/cloudflare-deploy.mjs
scripts/cloudflare-prepare.mjs
scripts/publish-desktop-update.mjs
tests/commercialization.test.mjs
tests/control-plane.test.mjs
tests/desktop-license-visibility.test.mjs
```
