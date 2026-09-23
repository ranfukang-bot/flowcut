let confirmationOpen = false;

// HTML dialogs keep keyboard focus in the renderer. JS confirm() can leave
// Windows Electron input controls unable to receive keyboard input.
export function confirmAction(message: string): Promise<boolean> {
  if (confirmationOpen) return Promise.resolve(false);
  confirmationOpen = true;
  return new Promise(resolve => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = document.createElement("dialog");
    dialog.className = "flowcut-confirm";
    dialog.setAttribute("aria-label", "确认操作");
    const title = document.createElement("h2"); title.textContent = "确认操作";
    const detail = document.createElement("p"); detail.textContent = message;
    const actions = document.createElement("div"); actions.className = "confirm-actions";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "secondary"; cancel.textContent = "取消";
    const approve = document.createElement("button"); approve.type = "button"; approve.className = "primary"; approve.textContent = "确认";
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      dialog.remove(); confirmationOpen = false;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(accepted);
    };
    cancel.onclick = () => finish(false);
    approve.onclick = () => finish(true);
    dialog.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
    dialog.addEventListener("close", () => finish(false));
    actions.appendChild(cancel); actions.appendChild(approve);
    dialog.appendChild(title); dialog.appendChild(detail); dialog.appendChild(actions);
    document.body.appendChild(dialog);
    try { dialog.showModal(); cancel.focus(); }
    catch { finish(false); }
  });
}
