// Model catalogue + download manager (progress, cancel, delete).
(function (NC) {
  if (typeof require !== "function") return; // Node not available
  const fs = require("fs");
  const path = require("path");
  const https = require("https");
  const os = require("os");
  const crypto = require("crypto");
  const { execFile } = require("child_process");

  const W = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
  const wf = (file, minBytes, sha256) => [{ name: file, url: W + file, minBytes, sha256 }];
  // 8-bit quantized (q8_0) weights: roughly half the download size and
  // noticeably faster to run than the full-precision .bin files, with only
  // a negligible accuracy difference — the same approach other caption
  // tools (e.g. Captioneer) use for their GPU transcription speed.
  const MODELS = [
    { id: "whisper-tiny-en", engine: "whisper", name: "Whisper Tiny (English)", size: "~42 MB",
      files: wf("ggml-tiny.en-q8_0.bin", 35e6, "5bc2b3860aa151a4c6e7bb095e1fcce7cf12c7b020ca08dcec0c6d018bb7dd94") },
    { id: "whisper-base-en", engine: "whisper", name: "Whisper Base (English)", size: "~78 MB",
      files: wf("ggml-base.en-q8_0.bin", 70e6, "a4d4a0768075e13cfd7e19df3ae2dbc4a68d37d36a7dad45e8410c9a34f8c87e") },
    { id: "whisper-small-en", engine: "whisper", name: "Whisper Small (English only)", size: "~252 MB",
      files: wf("ggml-small.en-q8_0.bin", 230e6, "67a179f608ea6114bd3fdb9060e762b588a3fb3bd00c4387971be4d177958067") },
    { id: "whisper-medium-en", engine: "whisper", name: "Whisper Medium (English)", size: "~785 MB",
      files: wf("ggml-medium.en-q8_0.bin", 700e6, "43fa2cd084de5a04399a896a9a7a786064e221365c01700cea4666005218f11c") },
    { id: "whisper-turbo", engine: "whisper", name: "Whisper Turbo (large-v3)", size: "~834 MB",
      files: wf("ggml-large-v3-turbo-q8_0.bin", 750e6, "317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1") },
  ];

  function userDir() {
    if (process.platform === "win32") return path.join(process.env.APPDATA || os.homedir(), "nCaption");
    if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "nCaption");
    return path.join(os.homedir(), ".config", "nCaption");
  }
  const modelsDir = () => path.join(userDir(), "models");
  const runtimeDir = () => path.join(userDir(), "runtime");
  const runtimePath = () => path.join(runtimeDir(), "whisper-cli");
  const hasWhisperRuntime = () => fs.existsSync(runtimePath());
  const fileDest = (m, f) => path.join(modelsDir(), f.name);
  const modelPath = (m) => fileDest(m, m.files[0]);
  const isInstalled = (m) => m.files.every((f) => fs.existsSync(fileDest(m, f)));

  // Generic downloader. Follows redirects, writes to .part, renames when complete.
  function downloadFile(url, dest, onProgress, expectMin, expectSha256) {
    let req = null, res = null, out = null, verifier = null, cancelled = false;
    let doCancel = () => {};
    const part = dest + ".part";
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const promise = new Promise((resolve, reject) => {
      const cleanup = () => { try { fs.unlinkSync(part); } catch (e) {} };
      const fail = (err) => { try { out && out.destroy(); } catch (e) {} cleanup(); reject(err); };

      function get(u, hops) {
        if (hops > 6) return fail(new Error("Too many redirects"));
        req = https.get(u, { headers: { "User-Agent": "nCaption" } }, (r) => {
          res = r;
          if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
            r.resume();
            return get(new URL(r.headers.location, u).toString(), hops + 1);
          }
          if (r.statusCode !== 200) { r.resume(); return fail(new Error("Download failed: HTTP " + r.statusCode)); }
          const total = parseInt(r.headers["content-length"] || "0", 10);
          let got = 0;
          out = fs.createWriteStream(part);
          r.on("data", (d) => { got += d.length; onProgress && onProgress(got, total); });
          r.pipe(out);
          out.on("finish", () => {
            if (cancelled) return;
            if ((total && got !== total) || (expectMin && got < expectMin)) return fail(new Error("Download incomplete"));
            const commit = () => {
              if (cancelled) return;
              try { fs.renameSync(part, dest); resolve(); } catch (e) { fail(e); }
            };
            if (expectSha256) {
              const hash = crypto.createHash("sha256");
              verifier = fs.createReadStream(part);
              verifier.on("data", (chunk) => hash.update(chunk));
              verifier.on("error", fail);
              verifier.on("end", () => {
                if (cancelled) return;
                if (hash.digest("hex") !== expectSha256)
                  return fail(new Error("Downloaded file checksum did not match; the file was discarded."));
                commit();
              });
            } else commit();
          });
          r.on("error", fail);
          out.on("error", fail);
        });
        req.on("error", (e) => (cancelled ? null : fail(e)));
      }
      get(url, 0);
      doCancel = () => {
        cancelled = true;
        try { req && req.destroy(); } catch (e) {}
        try { res && res.destroy(); } catch (e) {}
        try { out && out.destroy(); } catch (e) {}
        try { verifier && verifier.destroy(); } catch (e) {}
        setTimeout(cleanup, 100);
        reject(new Error("Cancelled"));
      };
    });
    return { promise, cancel: () => doCancel() };
  }

  function whisperRuntimeAsset() {
    if (process.platform !== "darwin") return null;
    if (process.arch === "arm64") return {
      url: "https://github.com/ghsnyc/whisper-cpp-macos-bin/releases/download/v1.9.1/whisper-cpp-v1.9.1-macos-arm64-metal.zip",
      minBytes: 1e6,
      sha256: "9114584927513ea0e22d9430fad449c9c8c8acde6b728479998e06feafd02812",
    };
    if (process.arch === "x64") return {
      url: "https://github.com/derektu/whisper-cpp-macos-bin/releases/download/v1.8.2/whisper-cpp-v1.8.2-macos-x86_64-accelerate.zip",
      minBytes: 900e3,
      sha256: "97876fa94571324da6afdb30897caa3a739e4f7f0bd8744dfdb9f4edc911446f",
    };
    return null;
  }

  function downloadWhisperRuntime(onProgress) {
    if (hasWhisperRuntime()) return { promise: Promise.resolve(), cancel: () => {} };
    const asset = whisperRuntimeAsset();
    if (!asset) return { promise: Promise.reject(new Error("Automatic Whisper runtime download is available on macOS Intel and Apple Silicon only.")), cancel: () => {} };
    fs.mkdirSync(runtimeDir(), { recursive: true });
    const archive = path.join(runtimeDir(), "whisper-cli.zip");
    const job = downloadFile(asset.url, archive, onProgress, asset.minBytes, asset.sha256);
    const promise = job.promise.then(async () => {
      try {
        const binary = await new Promise((resolve, reject) => {
          execFile("/usr/bin/unzip", ["-p", archive, "whisper-cli"], {
            encoding: "buffer",
            maxBuffer: 12 * 1024 * 1024,
          }, (err, stdout, stderr) => err ? reject(new Error(`Could not extract the Whisper runtime: ${stderr || err.message}`)) : resolve(stdout));
        });
        if (!Buffer.isBuffer(binary) || binary.length < 1e6) throw new Error("The Whisper runtime archive did not contain a valid executable.");
        const staging = runtimePath() + ".part";
        fs.writeFileSync(staging, binary, { mode: 0o755 });
        fs.chmodSync(staging, 0o755);
        try { fs.renameSync(staging, runtimePath()); }
        catch (e) { try { fs.unlinkSync(staging); } catch (ignored) {} throw e; }
        await new Promise((resolve, reject) => {
          execFile(runtimePath(), ["--help"], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024 },
            (err, stdout, stderr) => {
              const output = (stdout || "") + (stderr || "");
              if (err || !/whisper|usage|options/i.test(output))
                return reject(new Error(`Downloaded Whisper runtime could not start: ${output.slice(0, 300) || (err && err.message) || "no help output"}`));
              resolve();
            });
        });
      } catch (e) {
        try { fs.unlinkSync(runtimePath()); } catch (ignored) {}
        throw e;
      } finally {
        try { fs.unlinkSync(archive); } catch (ignored) {}
      }
    });
    return { promise, cancel: job.cancel };
  }

  // Downloads every file of a model, one after another. Returns { promise, cancel }.
  function downloadModel(m, onProgress) {
    let cancelled = false, current = null;
    const promise = (async () => {
      if (m.engine === "whisper" && !(NC.tx && NC.tx.tools().whisper)) {
        if (!hasWhisperRuntime()) {
          current = downloadWhisperRuntime((got, total) => onProgress && onProgress(got, total, "Whisper runtime"));
          await current.promise;
        }
      }
      for (const f of m.files) {
        if (fs.existsSync(fileDest(m, f))) continue;
        if (cancelled) throw new Error("Cancelled");
        current = downloadFile(f.url, fileDest(m, f),
          (got, total) => onProgress && onProgress(got, total, "Model"),
          f.minBytes, f.sha256);
        await current.promise;
      }
    })();
    return { promise, cancel: () => { cancelled = true; current && current.cancel(); } };
  }

  function removeModel(m) {
    for (const f of m.files) {
      try { fs.unlinkSync(fileDest(m, f)); } catch (e) {}
      try { fs.unlinkSync(fileDest(m, f) + ".part"); } catch (e) {}
    }
  }

  NC.models = {
    MODELS, userDir, modelsDir, modelPath, isInstalled,
    runtimePath, hasWhisperRuntime,
    downloadFile, downloadModel, removeModel,
  };
})((window.NC = window.NC || {}));
