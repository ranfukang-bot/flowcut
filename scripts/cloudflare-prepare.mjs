import { randomBytes, webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  databaseName,
  desktopDistributionPath,
  readJson,
  recoveryPath,
  secretsPath,
  stateDir,
  workerName,
  writePrivateJson,
} from "./cloudflare-common.mjs";

fs.mkdirSync(stateDir, { recursive: true });

if (!fs.existsSync(recoveryPath)) {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await webcrypto.subtle.exportKey(
    "jwk",
    keyPair.privateKey,
  );
  const publicJwk = await webcrypto.subtle.exportKey(
    "jwk",
    keyPair.publicKey,
  );
  const recovery = {
    formatVersion: 1,
    preparedAt: new Date().toISOString(),
    workerName,
    databaseName,
    databaseId: "",
    controlPlaneUrl: "",
    adminUsername: "admin",
    adminPassword: randomBytes(24).toString("base64url"),
    privateJwk,
    publicJwk,
  };
  writePrivateJson(recoveryPath, recovery);
}

const recovery = readJson(recoveryPath);
writePrivateJson(secretsPath, {
  FLOWCUT_ADMIN_PASSWORD: recovery.adminPassword,
  FLOWCUT_LICENSE_PRIVATE_JWK: JSON.stringify(recovery.privateJwk),
  FLOWCUT_LICENSE_PUBLIC_JWK: JSON.stringify(recovery.publicJwk),
});
writePrivateJson(desktopDistributionPath, {
  controlPlaneUrl: recovery.controlPlaneUrl || "",
  publicJwk: recovery.publicJwk,
});

fs.writeFileSync(
  path.join(stateDir, "管理员登录信息-请勿分享.txt"),
  [
    `管理员入口：${recovery.controlPlaneUrl || "部署后生成"}/admin`,
    `管理员账号：${recovery.adminUsername}`,
    `管理员密码：${recovery.adminPassword}`,
    "",
    "此文件只归软件所有者保管，不能发给软件使用者。",
    "普通使用者只需要管理员在后台创建的 FlowCut 账号和密码。",
    "",
  ].join("\r\n"),
  { encoding: "utf8", mode: 0o600 },
);

fs.writeFileSync(
  path.join(stateDir, "请勿分享-恢复资料说明.txt"),
  [
    "这里保存 FlowCut 授权中心的管理员密码和许可证签名私钥。",
    "不要发送给软件使用者，也不要提交到 GitHub、网盘公开链接或聊天群。",
    "请把整个 .flowcut-cloudflare 文件夹额外备份到你本人控制的加密硬盘或密码库。",
    "将来更换 ChatGPT、电脑或开发者时，需要 recovery.json 和最近一次数据库备份才能完整接管。",
    "",
  ].join("\r\n"),
  "utf8",
);

console.log("自有授权中心的密钥和恢复资料已经生成。");
console.log(`私密目录：${stateDir}`);
console.log(
  recovery.controlPlaneUrl
    ? `当前授权中心：${recovery.controlPlaneUrl}`
    : "下一步需要先登录你本人的 Cloudflare 账户，再执行部署。",
);
