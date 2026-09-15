// One fixed string only; no native bridge, user data, or attacker-selected URL.
parent.postMessage('{"cmd":"native_read_path","payload":{}}', document.querySelector('meta[name="host-origin"]').content);
