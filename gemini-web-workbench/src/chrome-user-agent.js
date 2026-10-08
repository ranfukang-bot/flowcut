function chromeUserAgent(chromeVersion) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(String(chromeVersion || ''))) {
    throw new Error('Chromium version is unavailable');
  }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    `(KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

module.exports = { chromeUserAgent };
