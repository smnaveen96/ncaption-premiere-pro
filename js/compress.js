// FFmpeg-based compression — the second stage of "Render & Compress":
// Premiere renders a high-quality master file, then this shrinks it to the
// user's chosen format/quality and writes the final file.
(function (NC) {
  if (typeof require !== "function") return;
  const { spawn } = require("child_process");

  function parseTimeToSeconds(hms) {
    const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(hms);
    if (!m) return 0;
    return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  }

  function run(ffmpeg, args, ctl, totalDuration, onProgress) {
    return new Promise((resolve, reject) => {
      const p = spawn(ffmpeg, args);
      ctl.proc = p;
      let err = "";
      p.stderr.on("data", (d) => {
        const s = d.toString();
        err = (err + s).slice(-8000);
        if (totalDuration > 0) {
          const m = /time=(\d+:\d+:\d+(?:\.\d+)?)/.exec(s);
          if (m) onProgress && onProgress(Math.min(100, Math.max(0, (parseTimeToSeconds(m[1]) / totalDuration) * 100)));
        }
      });
      p.on("error", reject);
      p.on("close", (code) => {
        ctl.proc = null;
        if (ctl.cancelled) return reject(new Error("Cancelled"));
        if (code === 0) return resolve();
        reject(new Error("ffmpeg failed (code " + code + "): " + err.slice(-300)));
      });
    });
  }

  // min(N,iw) with a backslash-escaped comma: ffmpeg's own filtergraph
  // parser (not a shell — we spawn with an argv array) needs the comma
  // inside min() escaped, or it reads as a second chained filter.
  const scaleFilter = (maxWidth) => `scale=min(${maxWidth}\\,iw):-2`;

  function buildArgs(input, outputNoExt, format, tier) {
    if (format === "mov") {
      // Only ProRes 4444 reliably preserves alpha in a MOV, so every tier
      // stays on that codec; "smaller" instead means scaling resolution
      // down, since CRF-style lossy tricks aren't available with alpha.
      const maxWidth = tier === "small" ? 1280 : tier === "medium" ? 1920 : 0;
      const args = ["-y", "-i", input];
      if (maxWidth) args.push("-vf", scaleFilter(maxWidth));
      args.push("-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-c:a", "pcm_s16le");
      const out = outputNoExt + ".mov";
      args.push(out);
      return { args, out };
    }
    const out = outputNoExt + ".mp4";
    const args = ["-y", "-i", input];
    if (tier === "normal") {
      // ffmpeg's own default H.264 settings (CRF ~23) — essentially
      // "ffmpeg -i input output", just explicit about audio + web-friendly.
      args.push("-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart");
    } else if (tier === "medium") {
      args.push("-c:v", "libx264", "-crf", "26", "-preset", "medium", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart");
    } else {
      args.push("-c:v", "libx264", "-crf", "32", "-preset", "medium", "-vf", scaleFilter(1280), "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart");
    }
    args.push(out);
    return { args, out };
  }

  // Compresses `input` into `outputNoExt.<mp4|mov>`. Returns { promise, cancel }.
  function compress(ffmpeg, input, outputNoExt, format, tier, totalDuration, onProgress) {
    const ctl = { cancelled: false, proc: null };
    const { args, out } = buildArgs(input, outputNoExt, format, tier);
    const promise = run(ffmpeg, args, ctl, totalDuration, onProgress).then(() => out);
    return { promise, cancel: () => { ctl.cancelled = true; try { ctl.proc && ctl.proc.kill(); } catch (e) {} } };
  }

  NC.compress = { compress };
})((window.NC = window.NC || {}));
