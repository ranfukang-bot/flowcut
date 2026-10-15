function createStateBroadcast(send, { schedule = setTimeout, cancel = clearTimeout } = {}) {
  let timer = null;
  const request = () => {
    if (timer !== null) return;
    timer = schedule(() => { timer = null; send(); }, 250);
    timer?.unref?.();
  };
  request.stop = () => { if (timer !== null) cancel(timer); timer = null; };
  return request;
}
module.exports = { createStateBroadcast };
