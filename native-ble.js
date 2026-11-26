/* 原生 App 蓝牙适配层
 * 仅当运行在 Android 壳里（window.NativeBle 存在）时生效；
 * 普通浏览器中 window.NativeBle 不存在，本文件直接返回，页面仍走 Web Bluetooth。 */
(function () {
  if (typeof window === 'undefined' || !window.NativeBle) return;

  window.__APP_SHELL__ = true;

  var SVC  = '7b8f0001-3c1a-4d8e-9a2b-6c1e5a7d9f01';
  var DATA = '7b8f0002-3c1a-4d8e-9a2b-6c1e5a7d9f01';
  var CTRL = '7b8f0003-3c1a-4d8e-9a2b-6c1e5a7d9f01';

  var connected = false;
  var connectResolve = null, connectReject = null;
  var scanning = null;
  var notifyTarget = null;
  var bufferedNotify = [];
  var disconnectedHandlers = [];
  var writeChain = Promise.resolve();
  var writeSeq = 0;
  var writeWaiters = new Map();
  var server = null;

  function b64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    var chunk = 0x8000, out = '';
    for (var i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(out);
  }

  function dispatchNotify(bytes) {
    if (!notifyTarget || notifyTarget.size === 0) { bufferedNotify.push(bytes); return; }
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    notifyTarget.forEach(function (fn) {
      try { fn({ target: { value: dv } }); } catch (e) {}
    });
  }

  /* 连接后主控变量表会立刻推上来，可能早于页面注册 onNotify。
   * 等到页面真正挂上监听再按原顺序补发，避免首批消息被丢掉。 */
  function flushBufferedNotify() {
    if (!notifyTarget || notifyTarget.size === 0 || bufferedNotify.length === 0) return;
    var pending = bufferedNotify;
    bufferedNotify = [];
    pending.forEach(dispatchNotify);
  }

  /* 原生层回调入口，事件为 JSON 字符串 */
  window.__bleEvent = function (raw) {
    var m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    switch (m.type) {
      case 'device': {
        if (!scanning) break;
        var s = scanning; scanning = null;
        s.resolve(m);
        break;
      }
      case 'scanEnd': {
        if (!scanning) break;
        var se = scanning; scanning = null;
        se.reject(new Error(m.message || '未找到设备'));
        break;
      }
      case 'connected': {
        connected = true;
        var cr = connectResolve;
        connectResolve = null; connectReject = null;
        if (cr) cr();
        break;
      }
      case 'disconnected': {
        connected = false;
        notifyTarget = null;
        bufferedNotify = [];
        disconnectedHandlers.slice().forEach(function (fn) {
          try { fn({}); } catch (e) {}
        });
        break;
      }
      case 'notify': {
        dispatchNotify(b64ToBytes(m.data));
        break;
      }
      case 'writeDone': {
        var w = writeWaiters.get(m.seq);
        if (w) { writeWaiters.delete(m.seq); w.resolve(); }
        break;
      }
      case 'writeFail': {
        var wf = writeWaiters.get(m.seq);
        if (wf) { writeWaiters.delete(m.seq); wf.reject(new Error(m.message || '写入失败')); }
        break;
      }
      case 'error': {
        if (scanning) {
          var se2 = scanning; scanning = null;
          se2.reject(new Error(m.message || '蓝牙错误'));
        } else if (connectReject) {
          var rj = connectReject;
          connectResolve = null; connectReject = null;
          rj(new Error(m.message || '连接失败'));
        }
        break;
      }
    }
  };

  function doWrite(uuid, data, withResponse) {
    var bytes = (data && data.buffer)
      ? new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength)
      : new Uint8Array(data);
    var b64 = bytesToB64(bytes);
    var seq = String(++writeSeq);

    var p = writeChain.then(function () {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          writeWaiters.delete(seq);
          reject(new Error('写入超时'));
        }, 4000);
        writeWaiters.set(seq, {
          resolve: function () { clearTimeout(timer); resolve(); },
          reject: function (e) { clearTimeout(timer); reject(e); }
        });
        try {
          window.NativeBle.write(uuid, b64, !!withResponse, seq);
        } catch (e) {
          clearTimeout(timer);
          writeWaiters.delete(seq);
          reject(e);
        }
      });
    });
    writeChain = p.catch(function () {});
    return p;
  }

  function makeChar(uuid) {
    var handlers = new Set();
    return {
      uuid: uuid,
      startNotifications: function () {
        notifyTarget = handlers;
        flushBufferedNotify();
        return Promise.resolve(this);
      },
      addEventListener: function (type, fn) {
        if (type === 'characteristicvaluechanged') {
          handlers.add(fn);
          /* 页面刚挂上监听，把连接后收到的首批通知补发出去 */
          flushBufferedNotify();
        }
      },
      removeEventListener: function (type, fn) {
        handlers.delete(fn);
      },
      writeValue: function (data) { return doWrite(uuid, data, false); },
      writeValueWithResponse: function (data) { return doWrite(uuid, data, true); }
    };
  }

  server = {
    getPrimaryService: function () {
      return Promise.resolve({
        getCharacteristic: function (uuid) { return Promise.resolve(makeChar(uuid)); }
      });
    }
  };

  function makeDevice(info) {
    return {
      id: info.address,
      name: info.name,
      addEventListener: function (type, fn) {
        if (type === 'gattserverdisconnected') disconnectedHandlers.push(fn);
      },
      removeEventListener: function (type, fn) {
        var i = disconnectedHandlers.indexOf(fn);
        if (i >= 0) disconnectedHandlers.splice(i, 1);
      },
      gatt: {
        get connected() { return connected; },
        connect: function () {
          return new Promise(function (resolve, reject) {
            if (connected) { resolve(server); return; }
            var settled = false;
            var timer = setTimeout(function () {
              if (settled) return;
              settled = true;
              connectResolve = null;
              connectReject = null;
              try { window.NativeBle.disconnect(); } catch (e) {}
              reject(new Error('连接超时，请确认设备已上电并在附近'));
            }, 12000);
            connectResolve = function () {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve(server);
            };
            connectReject = function (e) {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              reject(e);
            };
            window.NativeBle.connect(info.address, SVC, DATA, CTRL);
          });
        },
        disconnect: function () { window.NativeBle.disconnect(); }
      }
    };
  }

  var polyfill = {
    getAvailability: function () { return Promise.resolve(true); },
    requestDevice: function (options) {
      var filters = (options && options.filters) || [];
      var prefix = (filters[0] && filters[0].namePrefix) || '';
      return new Promise(function (resolve, reject) {
        scanning = {
          resolve: function (info) { resolve(makeDevice(info)); },
          reject: reject
        };
        try {
          window.NativeBle.scan(prefix, 10000);
        } catch (e) {
          scanning = null;
          reject(e);
        }
      });
    }
  };

  try {
    Object.defineProperty(navigator, 'bluetooth', { value: polyfill, configurable: true });
  } catch (e) {
    navigator.bluetooth = polyfill;
  }
})();
