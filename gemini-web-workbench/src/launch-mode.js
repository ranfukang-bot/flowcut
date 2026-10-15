function desktopLaunchMode(env = process.env) {
  const isolatedProfile = String(env.FLOWCUT_SMOKE_USER_DATA || '').trim();
  // A report path alone must never enable destructive smoke actions against
  // the normal profile. Interactive isolation keeps its visible main window.
  const smokeFile = isolatedProfile ? String(env.FLOWCUT_DESKTOP_SMOKE_FILE || '').trim() : '';
  const automaticSmoke = Boolean(smokeFile);
  return {
    isolatedProfile, isolated: Boolean(isolatedProfile), smokeFile, automaticSmoke,
    showMainWindow: !automaticSmoke,
    siteUrl: isolatedProfile ? 'http://127.0.0.1:4198' : '',
    publisherPort: isolatedProfile ? 18777 : 18776,
  };
}
module.exports = { desktopLaunchMode };
