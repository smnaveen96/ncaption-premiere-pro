// Prompt library (client guidelines) saved as JSON in the nCaption user folder.
(function (NC) {
  if (typeof require !== "function") return;
  const fs = require("fs");
  const path = require("path");
  const file = () => path.join(NC.models.userDir(), "prompts.json");

  const DEFAULTS = [{
    id: "default",
    name: "General cleanup",
    text: "Fix obvious transcription mistakes, punctuation and capitalization. Keep the speaker's natural, casual voice. Do not rephrase sentences or change word choice.",
  }];

  function load() {
    try {
      const list = JSON.parse(fs.readFileSync(file(), "utf8"));
      if (Array.isArray(list) && list.length) return list;
    } catch (e) {}
    return DEFAULTS.map((p) => Object.assign({}, p));
  }
  function save(list) {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(list, null, 2));
  }
  NC.prompts = { load, save };
})((window.NC = window.NC || {}));
