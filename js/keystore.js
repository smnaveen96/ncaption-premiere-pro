// API key storage: macOS Keychain when available, otherwise a private file.
(function (NC) {
  if (typeof require !== "function") return;
  const fs = require("fs");
  const path = require("path");
  const { execFile } = require("child_process");

  const SEC = "/usr/bin/security";
  const useKeychain = process.platform === "darwin" && fs.existsSync(SEC);
  const svc = (provider) => "nCaption-" + provider;
  const keyFile = () => path.join(NC.models.userDir(), "keys.json");

  const sh = (args) => new Promise((resolve, reject) => {
    execFile(SEC, args, (err, stdout) => (err ? reject(err) : resolve(String(stdout).replace(/\n$/, ""))));
  });

  function readFileStore() { try { return JSON.parse(fs.readFileSync(keyFile(), "utf8")); } catch (e) { return {}; } }
  function writeFileStore(o) {
    fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
    fs.writeFileSync(keyFile(), JSON.stringify(o), { mode: 0o600 });
  }

  async function get(provider) {
    if (useKeychain) { try { return await sh(["find-generic-password", "-a", "nCaption", "-s", svc(provider), "-w"]); } catch (e) { return ""; } }
    return readFileStore()[provider] || "";
  }
  async function set(provider, key) {
    if (useKeychain) { await sh(["add-generic-password", "-a", "nCaption", "-s", svc(provider), "-w", key, "-U"]); return; }
    const o = readFileStore(); o[provider] = key; writeFileStore(o);
  }
  async function remove(provider) {
    if (useKeychain) { try { await sh(["delete-generic-password", "-a", "nCaption", "-s", svc(provider)]); } catch (e) {} return; }
    const o = readFileStore(); delete o[provider]; writeFileStore(o);
  }
  // Show only the first few characters.
  const mask = (key) => (key ? key.slice(0, 7) + "••••••••" : "");

  NC.keys = { get, set, remove, mask, storage: useKeychain ? "macOS Keychain" : "a private file" };
})((window.NC = window.NC || {}));
