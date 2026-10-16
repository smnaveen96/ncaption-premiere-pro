// Audio extraction (ffmpeg) + transcription (whisper.cpp).
(function (NC) {
  if (typeof require !== "function") return;
  const fs = require("fs");
  const path = require("path");
  const os = require("os");
  const { spawn } = require("child_process");

  const DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", path.join(os.homedir(), ".local", "bin"), "C:\\Program Files\\ffmpeg\\bin"];
  const EXE = process.platform === "win32" ? ".exe" : "";

  function findBin(names, dirs) {
    for (const d of dirs || DIRS) for (const n of names) {
      const p = path.join(d, n + EXE);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
  const WHISPER_DIRS = [
    "/opt/homebrew/opt/whisper.cpp/bin", "/usr/local/opt/whisper.cpp/bin",
    "/opt/homebrew/opt/whisper-cpp/bin", "/usr/local/opt/whisper-cpp/bin",
  ].concat(DIRS);
  const tools = () => ({
    ffmpeg: findBin(["ffmpeg"]),
    ffprobe: findBin(["ffprobe"]),
    whisper: (NC.models && NC.models.hasWhisperRuntime() && NC.models.runtimePath()) ||
      findBin(["whisper-cli", "whisper-cpp"], WHISPER_DIRS),
  });

  function run(bin, args, ctl, onErr) {
    return new Promise((resolve, reject) => {
      const env = Object.assign({}, process.env, { PATH: DIRS.join(path.delimiter) + path.delimiter + (process.env.PATH || "") });
      const p = spawn(bin, args, { env });
      ctl.proc = p;
      let err = "";
      p.stderr.on("data", (d) => { const s = d.toString(); err = (err + s).slice(-8000); onErr && onErr(s); });
      p.on("error", reject);
      p.on("close", (code) => {
        ctl.proc = null;
        if (ctl.cancelled) return reject(new Error("Cancelled"));
        if (code === 0) return resolve();
        reject(new Error(path.basename(bin) + " failed (code " + code + "): " + err.slice(-300)));
      });
    });
  }

  // Cuts the clip's used range out of its source file as 16 kHz mono WAV.
  // A plain "-ss before -i" seek is fast but only keyframe/sync-sample
  // accurate, which was throwing caption timestamps off by up to ~1s versus
  // the timeline. We coarse-seek close to the target with input-side -ss
  // (fast), then trim the small remainder with output-side -ss (sample
  // accurate), so the extracted WAV starts exactly at sourceInSec.
  function extractAudio(ffmpeg, clip, wav, ctl) {
    const target = Number(clip.sourceInSec) || 0;
    const coarse = Math.max(0, target - 5);
    const fine = target - coarse;
    const args = ["-y", "-ss", String(coarse), "-i", clip.path, "-ss", String(fine), "-t", String(clip.sourceDurSec)];
    if (clip.reversed) args.push("-af", "areverse");
    args.push("-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav);
    return run(ffmpeg, args, ctl);
  }

  // Whisper: returns SRT cues (times relative to the start of the WAV).
  async function whisper(bin, model, wav, ctl, onProgress) {
    const base = wav.replace(/\.wav$/, "");
    const args = ["-m", model, "-f", wav, "-l", "en", "-osrt", "-of", base, "-pp"];
    await run(bin, args, ctl, (s) => {
      const all = [...s.matchAll(/progress\s*=\s*(\d+)%/g)];
      if (all.length) onProgress && onProgress(+all[all.length - 1][1]);
    });
    const text = fs.readFileSync(base + ".srt", "utf8");
    try { fs.unlinkSync(base + ".srt"); } catch (e) {}
    return NC.srt.parseSrt(text);
  }

  function mapCueToSequence(cue, clip) {
    const sourceDuration = Number(clip.sourceDurSec);
    const sequenceDuration = Number(clip.sequenceDurSec);
    const speed = Number(clip.speed);
    const scale = sourceDuration > 0 && sequenceDuration > 0
      ? sequenceDuration / sourceDuration
      : speed > 0 ? 1 / speed : 1;
    const start = Math.max(0, Number(cue.start) || 0);
    const end = Math.max(start, Number(cue.end) || 0);
    const sourceStart = sourceDuration > 0 ? Math.min(sourceDuration, start) : start;
    const sourceEnd = sourceDuration > 0 ? Math.min(sourceDuration, end) : end;
    if (sourceEnd <= sourceStart) return null;
    return {
      start: clip.startSec + sourceStart * scale,
      end: clip.startSec + sourceEnd * scale,
      text: cue.text,
    };
  }

  const tmpWav = (i) => path.join(os.tmpdir(), "ncaption_" + process.pid + "_" + i + ".wav");

  // Media duration in seconds, via ffprobe; used to turn ffmpeg's "time="
  // progress lines into a percentage. Returns 0 (caller falls back to an
  // indeterminate progress bar) if ffprobe is unavailable or fails.
  function probeDuration(ffprobe, file) {
    return new Promise((resolve) => {
      if (!ffprobe) return resolve(0);
      const args = ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file];
      const p = spawn(ffprobe, args);
      let out = "";
      p.stdout.on("data", (d) => { out += d.toString(); });
      p.on("error", () => resolve(0));
      p.on("close", () => {
        const n = parseFloat(out.trim());
        resolve(Number.isFinite(n) && n > 0 ? n : 0);
      });
    });
  }

  NC.tx = { tools, extractAudio, whisper, mapCueToSequence, tmpWav, probeDuration };
})((window.NC = window.NC || {}));
