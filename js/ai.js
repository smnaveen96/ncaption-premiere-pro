// AI cleanup of caption lines (Claude / OpenAI). Line count and order are preserved.
(function (NC) {
  if (typeof require !== "function") return;
  const https = require("https");

  const BASE_SYSTEM =
    "You clean up auto-generated video subtitles. You receive numbered lines in the form 'N|text'. " +
    "Return exactly the same lines in the same order, each as 'N|corrected text'. " +
    "Fix transcription errors, spelling, punctuation and capitalization following the guidelines below. " +
    "Never merge, split, add, drop or reorder lines, and never move words between lines. " +
    "Keep each line's meaning and length close to the original, because every line is shown for a fixed time. " +
    "Lines under CONTEXT are for reference only: do not return them. " +
    "Output only the numbered lines, with no commentary and no code fences.\n\nGuidelines:\n";

  function post(host, pathname, headers, body, ctl) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const req = https.request({
        host, path: pathname, method: "POST",
        headers: Object.assign({ "content-type": "application/json", "content-length": Buffer.byteLength(data) }, headers),
      }, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (buf += d));
        res.on("end", () => resolve({ status: res.statusCode, body: buf }));
      });
      ctl.req = req;
      req.on("error", (e) => reject(ctl.cancelled ? new Error("Cancelled") : e));
      req.setTimeout(120000, () => req.destroy(new Error("Request timed out")));
      req.write(data);
      req.end();
    });
  }
  function get(host, pathname, headers) {
    return new Promise((resolve, reject) => {
      const req = https.get({ host, path: pathname, headers }, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (buf += d));
        res.on("end", () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on("error", reject);
      req.setTimeout(30000, () => req.destroy(new Error("Request timed out")));
    });
  }
  const impl = { post, get };

  function errMsg(r) {
    try { const j = JSON.parse(r.body); if (j.error && j.error.message) return j.error.message; } catch (e) {}
    return "HTTP " + r.status;
  }

  async function listModels(provider, key) {
    const models = [];
    let afterId = "";
    do {
      const pathname = provider === "claude"
        ? "/v1/models?limit=1000" + (afterId ? "&after_id=" + encodeURIComponent(afterId) : "")
        : "/v1/models";
      const r = await impl.get(
        provider === "claude" ? "api.anthropic.com" : "api.openai.com",
        pathname,
        provider === "claude"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { authorization: "Bearer " + key }
      );
      if (r.status < 200 || r.status >= 300) { const e = new Error(errMsg(r)); e.status = r.status; throw e; }
      const j = JSON.parse(r.body);
      const ids = (j.data || []).map((m) => m.id).filter(Boolean);
      models.push(...(provider === "openai"
        ? ids.filter((id) =>
          /^(gpt-|o[1-9](?:-|$)|chatgpt-|ft:(?:gpt-|o[1-9]))/.test(id) &&
          !/-(?:audio|transcribe|tts|realtime|embedding|moderation|image)(?:-|$)/.test(id))
        : ids));
      afterId = provider === "claude" && j.has_more ? j.last_id : "";
      if (afterId && models.length > 10000) throw new Error("Model list exceeded the safety limit.");
    } while (afterId);
    return models;
  }

  async function callModel(o, userText) {
    let r;
    if (o.provider === "claude") {
      r = await impl.post("api.anthropic.com", "/v1/messages",
        { "x-api-key": o.key, "anthropic-version": "2023-06-01" },
        { model: o.model, max_tokens: 4096, system: o.system, messages: [{ role: "user", content: userText }] }, o.ctl);
    } else {
      r = await impl.post("api.openai.com", "/v1/chat/completions",
        { authorization: "Bearer " + o.key },
        { model: o.model, messages: [{ role: "system", content: o.system }, { role: "user", content: userText }] }, o.ctl);
    }
    if (r.status < 200 || r.status >= 300) { const e = new Error(errMsg(r)); e.status = r.status; throw e; }
    const j = JSON.parse(r.body);
    return o.provider === "claude"
      ? (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("")
      : (j.choices && j.choices[0] && j.choices[0].message.content) || "";
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function withRetry(o, userText) {
    for (let attempt = 0; ; attempt++) {
      try { return await callModel(o, userText); }
      catch (e) {
        const retryable = e.status === 429 || e.status >= 500 || e.status === 529;
        if (!retryable || attempt >= 2 || o.ctl.cancelled) throw e;
        await sleep(1500 * (attempt + 1));
      }
    }
  }

  function parseReply(text, ids) {
    const map = {};
    for (const line of String(text).split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s*\|\s?(.*)$/);
      if (m) map[m[1]] = m[2].trim();
    }
    return map;
  }

  // o: { provider, key, model, prompt, lines[], ctl, onProgress(done,total), batch }
  async function cleanup(o) {
    const BATCH = o.batch || 40, CONTEXT = 3;
    o.system = BASE_SYSTEM + (o.prompt || "").trim();
    const out = o.lines.slice();
    let missing = 0;
    for (let s = 0; s < o.lines.length; s += BATCH) {
      if (o.ctl.cancelled) throw new Error("Cancelled");
      const slice = o.lines.slice(s, s + BATCH);
      const ctx = o.lines.slice(Math.max(0, s - CONTEXT), s);
      const user = (ctx.length ? "CONTEXT (do not return):\n" + ctx.join("\n") + "\n\n" : "") +
        "LINES TO CLEAN:\n" + slice.map((t, i) => `${s + i + 1}|${t}`).join("\n");
      const map = parseReply(await withRetry(o, user));
      slice.forEach((t, i) => {
        const v = map[String(s + i + 1)];
        if (v === undefined || v === "") missing++; else out[s + i] = v;
      });
      o.onProgress && o.onProgress(Math.min(s + BATCH, o.lines.length), o.lines.length);
    }
    return { texts: out, missing };
  }

  NC.ai = { cleanup, listModels, _impl: impl, BASE_SYSTEM };
})((window.NC = window.NC || {}));
