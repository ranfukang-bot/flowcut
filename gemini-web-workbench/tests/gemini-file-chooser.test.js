const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  CLICK_UPLOAD_CONTROL_SCRIPT,
  DETECT_GEMINI_AUTH_SCRIPT,
  uploadFilesViaChooser,
} = require("../src/gemini-file-chooser");

test('hidden stale upload menu is ignored in favor of visible trigger',()=>{
  const vm=require('node:vm');
  const make=(text,hidden)=>({isConnected:true,innerText:text,hidden,getAttribute:()=>text,
    getBoundingClientRect:()=>({x:10,y:10,width:hidden?0:30,height:hidden?0:30})});
  const stale=make('上传文件',true),trigger=make('上传和工具',false);
  const result=vm.runInNewContext(CLICK_UPLOAD_CONTROL_SCRIPT,{
    getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'}),
    document:{body:{innerText:''},querySelector:s=>s.includes('local-images')?stale:null,
      querySelectorAll:s=>s.includes('local-images')?[stale]:[trigger]},
  });
  assert.equal(result.status,'upload-trigger-ready');
});

test('timeout cancels pending target lookup; it cannot click after return',async()=>{
  const {webContents}=fixture(null);
  let release;
  webContents.executeJavaScript=()=>new Promise(resolve=>{release=resolve;});
  const keepAlive=setTimeout(()=>{},200);
  try {
    const result=await uploadFilesViaChooser(webContents,['one.webp'],20);
    assert.equal(result.ok,false);
    release({status:'upload-item-ready',rect:{x:1,y:1,width:10,height:10}});
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(webContents.inputEvents.length,0);
  }finally{clearTimeout(keepAlive);}
});

function fixture(clickResult) {
  class MockDebugger extends EventEmitter {
    constructor() {
      super();
      this.attached = false;
      this.commands = [];
    }
    isAttached() {
      return this.attached;
    }
    attach() {
      this.attached = true;
    }
    detach() {
      this.attached = false;
    }
    async sendCommand(method, params) {
      this.commands.push({ method, params });
      if (method === "DOM.resolveNode") {
        return { object: { objectId: "file-input-1" } };
      }
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: [
              { name: "product-1.jpg", size: 100, type: "image/jpeg" },
              { name: "product-2.jpg", size: 200, type: "image/jpeg" },
            ],
          },
        };
      }
      return {};
    }
  }
  const debuggerApi = new MockDebugger();
  const webContents = {
    debugger: debuggerApi,
    inputEvents: [],
    sendInputEvent(event) {
      this.inputEvents.push(event);
    },
    async executeJavaScript() {
      if (clickResult?.status === "clicked") {
        setImmediate(() => {
          debuggerApi.emit(
            "message",
            {},
            "Page.fileChooserOpened",
            { backendNodeId: 42, mode: "selectMultiple" }
          );
        });
      }
      return clickResult;
    },
  };
  return { debuggerApi, webContents };
}

test("native Gemini upload assigns files through the intercepted chooser", async () => {
  const { debuggerApi, webContents } = fixture({ status: "clicked" });
  const result = await uploadFilesViaChooser(
    webContents,
    ["C:\\tmp\\product-1.jpg", "C:\\tmp\\product-2.jpg"],
    1000
  );

  assert.equal(result.ok, true);
  assert.equal(result.selectedFileCount, 2);
  const selectedAt = debuggerApi.commands.findIndex(command => command.method === 'DOM.setFileInputFiles');
  const notifiedAt = debuggerApi.commands.findIndex(command => command.method === 'Runtime.callFunctionOn' && command.params.functionDeclaration.includes('dispatchEvent'));
  assert.ok(selectedAt >= 0);
  assert.equal(notifiedAt, -1, 'CDP 已触发文件事件，不得重复通知导致双份上传');
  assert.deepEqual(
    debuggerApi.commands.find(
      (command) => command.method === "DOM.setFileInputFiles"
    )?.params,
    {
      files: ["C:\\tmp\\product-1.jpg", "C:\\tmp\\product-2.jpg"],
      backendNodeId: 42,
    }
  );
  assert.equal(debuggerApi.isAttached(), false);
});

test("signed-out Gemini menu requests login instead of reporting upload failure", async () => {
  const { debuggerApi, webContents } = fixture({ status: "needs-login" });
  const result = await uploadFilesViaChooser(
    webContents,
    ["C:\\tmp\\product-1.jpg"],
    1000
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "NEEDS_LOGIN");
  assert.equal(
    debuggerApi.commands.some(
      (command) => command.method === "DOM.setFileInputFiles"
    ),
    false
  );
});

test("file chooser events are handled even while the page click is blocked", async () => {
  const { debuggerApi, webContents } = fixture({ status: "clicked" });
  let releaseClick = null;
  webContents.executeJavaScript = () =>
    new Promise((resolve) => {
      releaseClick = () => resolve({ status: "clicked" });
      setImmediate(() => {
        debuggerApi.emit(
          "message",
          {},
          "Page.fileChooserOpened",
          { backendNodeId: 84, mode: "selectMultiple" }
        );
      });
    });
  const originalSendCommand = debuggerApi.sendCommand.bind(debuggerApi);
  debuggerApi.sendCommand = async (method, params) => {
    const result = await originalSendCommand(method, params);
    if (method === "DOM.setFileInputFiles") releaseClick?.();
    return result;
  };

  const result = await uploadFilesViaChooser(
    webContents,
    ["C:\\tmp\\product-1.jpg"],
    1000
  );

  assert.equal(result.ok, true);
  assert.equal(
    debuggerApi.commands.some(
      (command) => command.method === "DOM.setFileInputFiles"
    ),
    true
  );
});

test("Gemini upload menu and upload item are clicked in separate user gestures", async () => {
  const { debuggerApi, webContents } = fixture({ status: "menu-opened" });
  let calls = 0;
  webContents.executeJavaScript = async (_script, userGesture) => {
    calls += 1;
    assert.equal(userGesture, true);
    if (calls === 1) return { status: "menu-opened" };
    setImmediate(() => {
      debuggerApi.emit(
        "message",
        {},
        "Page.fileChooserOpened",
        { backendNodeId: 126, mode: "selectMultiple" }
      );
    });
    return { status: "clicked", label: "上传文件" };
  };

  const result = await uploadFilesViaChooser(
    webContents,
    ["C:\\tmp\\product-1.jpg"],
    1000
  );

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(
    debuggerApi.commands.some(
      (command) => command.method === "DOM.setFileInputFiles"
    ),
    true
  );
});

test("Gemini upload controls use trusted mouse input when coordinates are available", async () => {
  const { debuggerApi, webContents } = fixture(null);
  let calls = 0;
  webContents.executeJavaScript = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        status: "upload-trigger-ready",
        rect: { x: 10, y: 20, width: 40, height: 30 },
      };
    }
    setImmediate(() => {
      debuggerApi.emit(
        "message",
        {},
        "Page.fileChooserOpened",
        { backendNodeId: 168, mode: "selectMultiple" }
      );
    });
    return {
      status: "upload-item-ready",
      rect: { x: 30, y: 60, width: 80, height: 32 },
    };
  };

  const result = await uploadFilesViaChooser(
    webContents,
    ["C:\\tmp\\product-1.jpg"],
    1000
  );

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(
    webContents.inputEvents.filter((event) => event.type === "mouseDown").length,
    2
  );
});

test("Gemini auth state is verified from the rendered page", () => {
  assert.match(DETECT_GEMINI_AUTH_SCRIPT, /sign-out-banner/);
  assert.match(DETECT_GEMINI_AUTH_SCRIPT, /Sign in with Google/);
  assert.match(DETECT_GEMINI_AUTH_SCRIPT, /signed-out/);
  assert.match(DETECT_GEMINI_AUTH_SCRIPT, /signed-in/);
});
