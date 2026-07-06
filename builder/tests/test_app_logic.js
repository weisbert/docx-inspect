// Self-contained fake-DOM harness for app.html's pure logic.
//
// app.html is a single file whose logic lives in one big inline <script>. This
// loads that script under a stubbed browser environment (a Proxy that absorbs any
// DOM access) with the top-level boot() neutralized, then asserts the pure,
// DOM-free helpers behave. It is intentionally NEUTRAL (English, synthetic data)
// so it can live in the public repo; project-specific data cases belong under
// local/tests/.
//
//   node builder/tests/test_app_logic.js
//
// Exercises: stripInternal (drop editor-local _keys), rowsFromSpec / tableFromPreset
// / configTablePresets (table presets keep their condition rows), subtreeMatches
// (outline filter), imgUrl / bumpImgVer (stable image URLs), warningJumpTarget
// (clickable export warnings). Also a smoke that renderTree runs without throwing.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_HTML = path.join(__dirname, "..", "app.html");
let html = fs.readFileSync(APP_HTML, "utf8");
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(m => m[1]).sort((a, b) => a.length - b.length);
let src = blocks[blocks.length - 1] || "";
src = src.replace(/\bboot\(\);/g, "/* boot() neutralized */");

// A Proxy stub that absorbs any property access / call / construct.
function stub() {
  const f = function () { return P; };
  const P = new Proxy(f, {
    get(t, prop) {
      if (prop === "then") return undefined;
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "length") return 0;
      if (prop === "classList") return { add(){}, remove(){}, toggle(){}, contains(){return false} };
      if (prop === "style") return {};
      if (prop === "value") return "";
      if (prop === "dataset") return {};
      return P;
    },
    apply() { return P; },
    construct() { return P; },
  });
  return P;
}

const sandbox = {
  document: stub(),
  navigator: { clipboard: { readText: () => Promise.resolve(""), writeText: () => Promise.resolve() } },
  localStorage: { getItem(){return null;}, setItem(){}, removeItem(){} },
  location: { search: "", href: "", pathname: "/" },
  fetch: () => new Promise(() => {}),
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
  addEventListener: () => {}, removeEventListener: () => {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  console, URLSearchParams,
  FileReader: function(){ this.readAsDataURL = () => {}; },
  Promise, JSON, Math, Date, Array, Object,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "app.html:inline-script" });

let fails = 0;
function ok(cond, name, detail) {
  console.log((cond ? "  PASS " : "  FAIL ") + name + (cond ? "" : "  -> " + detail));
  if (!cond) fails++;
}

// stripInternal
const si = sandbox.stripInternal;
ok(typeof si === "function", "stripInternal defined");
const stripped = si({ id: "n1", _collapsed: true, origin: "template",
  blocks: [{ type: "para", _dirty: 1 }], children: [{ id: "n2", _collapsed: false }] });
const sjson = JSON.stringify(stripped);
ok(!/_collapsed/.test(sjson) && !/_dirty/.test(sjson), "stripInternal drops _-keys (nested)", sjson);
ok(/"origin":"template"/.test(sjson), "stripInternal keeps non-_ keys", sjson);

// table presets carry condition rows
vm.runInContext("App.config = " + JSON.stringify({
  compliance: { axis_labels: ["MIN","TYP","MAX","NTWC"], setting_kinds: ["common_setting","module_setting","tb"] },
  table_presets: [
    { key: "pn", label: "PN", base: "compliance", caption: "PN",
      setting_rows: [{ cat: "Condition", item: "Temp", unit: "C" }],
      result_rows: [{ cat: "PN", item: "@1M", unit: "dBc/Hz", limit: "le" }] },
    { key: "cond", label: "Cond", base: "plain", caption: "Cond",
      rows: [["Parameter","Value"],["Temp",""]] },
  ],
}) + ";", sandbox);
ok(sandbox.configTablePresets().length === 2, "configTablePresets reads App.config");
const pn = sandbox.tableTemplate("pn");
ok(pn.type === "datatable" && pn.data.rows.some(r => r.kind === "common_setting"),
   "preset 'pn' bakes in a condition row");
ok(pn.data.rows.some(r => r.item === "@1M" && r.limit === "le"), "preset 'pn' result row carries limit");
ok(sandbox.tableTemplate("cond").rows[0][0] === "Parameter", "preset 'cond' is a plain 2-col table");
ok(sandbox.tableTemplate("compliance").data.rows.some(r => r.kind === "common_setting"),
   "built-in compliance preset still has setting rows");

// outline filter
ok(sandbox.subtreeMatches({ title: "Phase Noise" }, "noise") === true, "subtreeMatches self");
ok(sandbox.subtreeMatches({ title: "X", children: [{ title: "deep noise" }] }, "noise") === true, "subtreeMatches descendant");
ok(sandbox.subtreeMatches({ title: "X", children: [{ title: "Y" }] }, "zzz") === false, "subtreeMatches no match");

// stable image URL
vm.runInContext("App.dir='proj'; App._imgVer={};", sandbox);
ok(sandbox.imgUrl("images/a.png") === "images/a.png?dir=proj", "imgUrl has no Date.now cache-buster");
sandbox.bumpImgVer("images/a.png");
ok(sandbox.imgUrl("images/a.png").indexOf("&v=1") >= 0, "imgUrl reflects a bumped version");

// clickable warning target
vm.runInContext("App.project={outline:[{id:'X',title:'Phase Noise',blocks:[],children:[]}]};", sandbox);
ok(sandbox.warningJumpTarget('section "Phase Noise" / block 0 (datatable)') === "X", "warningJumpTarget resolves a section title");
ok(sandbox.warningJumpTarget("chapter 2 / block 1") === null, "warningJumpTarget null for a non-section location");

// caption numbers mirror engine _collect_ref_targets (chapter-scoped Figure/Table:
// images always number; tables number only when captioned; counters reset per top
// chapter and continue into children; fixed_body media is skipped)
vm.runInContext("App.ui={}; App.project={outline:[" +
  "{id:'c1',title:'Ch1',blocks:[" +
    "{type:'image',id:'img1',caption:'a'}," +
    "{type:'datatable',id:'dt1',caption:'t'}," +
    "{type:'datatable',id:'dtnc'}," +
    "{type:'imagegrid',id:'grid1',caption:'g'}]," +
    "children:[{id:'c1a',title:'Ch1a',blocks:[{type:'image',id:'imgc',caption:'c'}],children:[]}]}," +
  "{id:'fb',title:'Fixed',fixed_body:'std',blocks:[{type:'image',id:'ignored',caption:'x'}],children:[]}," +
  "{id:'c2',title:'Ch2',blocks:[{type:'image',id:'img2',caption:'i'},{type:'table',id:'tbl2',caption:'tt'}],children:[]}" +
  "]};", sandbox);
const cn = sandbox.computeCaptionNumbers();
ok(cn.img1 && cn.img1.num === "1-1" && cn.img1.kind === "Figure", "caption: image -> Figure 1-1");
ok(cn.dt1 && cn.dt1.num === "1-1" && cn.dt1.kind === "Table", "caption: captioned datatable -> Table 1-1");
ok(!cn.dtnc, "caption: uncaptioned table gets no number");
ok(cn.grid1 && cn.grid1.num === "1-2", "caption: imagegrid continues figure seq (1-2)");
ok(cn.imgc && cn.imgc.num === "1-3", "caption: child image continues chapter seq (1-3)");
ok(!cn.ignored, "caption: fixed_body media is skipped");
// the fixed_body node still consumes chapter 2 (it IS a Heading 1), so c2 is
// chapter 3 -- matching the engine's per-top-level-node chapter counter.
ok(cn.img2 && cn.img2.num === "3-1", "caption: image after a fixed_body chapter -> 3-1");
ok(cn.tbl2 && cn.tbl2.num === "3-1", "caption: table after a fixed_body chapter -> 3-1");

// groupBlocks: legacy adjacent paragraphs stay one card (existing reports render
// unchanged); a cardStart paragraph begins a new card so separately-added text
// blocks never auto-merge; a media block always breaks the run.
const gb = sandbox.groupBlocks;
const gbLegacy = gb([{ type: "para" }, { type: "para" }, { type: "para" }]);
ok(gbLegacy.length === 1 && gbLegacy[0].kind === "prose" && gbLegacy[0].blocks.length === 3,
   "groupBlocks: legacy adjacent paragraphs -> one card");
const gbSplit = gb([{ type: "para" }, { type: "para", cardStart: true }, { type: "para" }]);
ok(gbSplit.length === 2 && gbSplit[0].blocks.length === 1 && gbSplit[1].blocks.length === 2,
   "groupBlocks: cardStart begins a new text card");
const gbMedia = gb([{ type: "para" }, { type: "image" }, { type: "para" }]);
ok(gbMedia.length === 3 && gbMedia[1].kind === "block" &&
   gbMedia[0].kind === "prose" && gbMedia[2].kind === "prose",
   "groupBlocks: a media block breaks the text run");

// renderTree runs without throwing (stubbed DOM)
vm.runInContext("App.selId='X'; App._treeFilter='';", sandbox);
try { sandbox.renderTree(); ok(true, "renderTree() runs without throwing"); }
catch (e) { ok(false, "renderTree() runs without throwing", e && e.message); }

// renderNodeEditor smoke: a section with a text card + a captioned image exercises
// the new caption-number badge (capNum) and the drag-seam wiring during render.
vm.runInContext("App.project={outline:[{id:'S',title:'Sec',blocks:[" +
  "{type:'para',runs:[{t:'hi'}],cardStart:true}," +
  "{type:'image',id:'im1',file:'images/x.png',caption:'a fig'}," +
  "{type:'table',id:'tb1',caption:'t',rows:[['a','b']],header_rows:1}],children:[]}]};", sandbox);
try { vm.runInContext("renderNodeEditor(el('div'), App.project.outline[0]);", sandbox);
  ok(true, "renderNodeEditor runs (text card + image + table w/ xlsx button)"); }
catch (e) { ok(false, "renderNodeEditor runs (text card + image + table w/ xlsx button)", e && e.message); }

console.log(fails ? ("\nFAILURES: " + fails) : "\nALL APP-LOGIC TESTS PASSED");
process.exit(fails ? 1 : 0);
