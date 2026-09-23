const WINDOWS_RESERVED_NAMES =
  /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function validateTikTokAccountName(input: unknown) {
  const name = String(input || "").trim();
  if (!name) throw new Error("请输入 TK 账号名");
  if (name.length > 80) throw new Error("TK 账号名不能超过 80 个字符");
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name)) {
    throw new Error('TK 账号名不能包含 < > : " / \\ | ? *');
  }
  if (/[. ]$/.test(name)) {
    throw new Error("TK 账号名不能以句点或空格结尾");
  }
  if (WINDOWS_RESERVED_NAMES.test(name)) {
    throw new Error("该名称是 Windows 保留名称，请换一个 TK 账号名");
  }
  return name;
}

export function validateArchiveDirectory(value: unknown) {
  const directory = String(value || "").trim();
  if (!directory) return ""; // Legacy accounts use the configured root/account folder.
  if (directory.length > 1000 || /[\x00-\x1f<>"|?*]/.test(directory) ||
      !/^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(directory)) {
    throw new Error("请选择有效的 Windows 保存文件夹");
  }
  return directory;
}
