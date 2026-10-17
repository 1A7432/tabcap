// tabcap overlay adapter: isolated-world page script (docs/09 §2.3, §9).
// One JavaScript expression: an object of hook functions. Read-only: it reads
// layout, computed styles and text and never changes the page (no scrolling,
// no focus, no events, no writes). collect() gathers plain data, classify() is
// a pure function of that data (unit-tested on fixtures/dom/), describe() and
// act("covered") combine both; act("buttons") lists a whole document's close
// buttons (an iframe layer's inner document, 0.4-I). Results are { data, nodes }: every `n` in data
// indexes `nodes`, which the daemon turns into refs.
({
  collect() {
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const nodes = [];
    const info = [];
    const at = new Map();
    const idx = (el) => {
      let i = at.get(el);
      if (i === undefined) {
        i = nodes.length;
        at.set(el, i);
        nodes.push(el);
        info.push({ tag: el.localName, id: String(el.getAttribute("id") || "").slice(0, 80), cls: String(el.getAttribute("class") || "").slice(0, 120) });
      }
      return i;
    };
    const clean = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
    const alpha = (c) => {
      const m = /rgba?\(([^)]*)\)/.exec(c || "");
      if (!m) return c && c !== "transparent" ? 1 : 0;
      const p = m[1].split(/[\s,/]+/).filter(Boolean);
      if (p.length < 4) return 1;
      const a = parseFloat(p[3]);
      return Number.isFinite(a) ? (p[3].endsWith("%") ? a / 100 : a) : 1;
    };
    const box = (el, cs) => {
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || Number(cs.opacity) === 0) return null;
      const r = el.getBoundingClientRect();
      return r.width >= 1 && r.height >= 1 ? r : null;
    };
    const clipArea = (r) => Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left)) * Math.max(0, Math.min(vh, r.bottom) - Math.max(0, r.top));
    const nameOf = (el) => {
      const label = el.getAttribute("aria-label");
      if (label) return clean(label, 60);
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((x) => x.textContent).join(" ");
        if (clean(t, 60)) return clean(t, 60);
      }
      const h = el.querySelector("h1, h2, h3, h4, h5, h6, legend, [class*=title], [class*=Title], [class*=header] > span");
      return h ? clean(h.textContent, 60) : "";
    };
    const BTN = "button, a[href], [role=button], input[type=button], input[type=submit], input[type=reset], [onclick], [class*=close], [class*=Close]";
    const CONTROL = "button, input:not([type=hidden]), select, textarea, a[href], [role=button]";
    /**
     * 0.7.3: a full-viewport fixed layer that wraps a dialog without giving it
     * a role (common framework markup). Thresholds (docs/10):
     * - the layer is fixed, pointer-reachable and covers >= 90% of the viewport
     *   (small fixed headers / footers never qualify);
     * - one visible inner block covers <= 60% of the viewport, has an opaque
     *   background or a visible border / shadow, and holds a button or form
     *   control;
     * - the layer's own text stays <= 500 characters, so a full-screen app root
     *   (scrolling content, lots of text, no mask) is not taken for a dialog.
     */
    const innerDialog = (el, c) => {
      if (!c.fixed || c.area < 0.9 || !c.pointer) return null;
      if (String(el.innerText || "").trim().length > 500) return null;
      const all = el.querySelectorAll("body *");
      for (let i = 0; i < all.length && i < 4000; i++) {
        const b = all[i];
        if (b === el) continue;
        const bcs = getComputedStyle(b);
        const br = box(b, bcs);
        if (!br) continue;
        const ba = vw * vh > 0 ? clipArea(br) / (vw * vh) : 0;
        if (ba < 0.005 || ba > 0.6) continue;
        const bo = Number(bcs.opacity);
        const bbg = Math.round(alpha(bcs.backgroundColor) * (Number.isFinite(bo) ? bo : 1) * 100) / 100;
        const border = ["Top", "Right", "Bottom", "Left"].some((side) => {
          const w = parseFloat(bcs["border" + side + "Width"] || "0");
          return w > 0 && bcs["border" + side + "Style"] !== "none" && alpha(bcs["border" + side + "Color"]) > 0;
        });
        const shadow = typeof bcs.boxShadow === "string" && bcs.boxShadow !== "none" && bcs.boxShadow.trim() !== "";
        if (bbg < 0.5 && !border && !shadow) continue;
        const control = b.matches(CONTROL) || [...b.querySelectorAll(CONTROL)].some((x) => box(x, getComputedStyle(x)) !== null);
        if (!control) continue;
        return { name: clean(b.getAttribute("aria-label") || b.innerText || "", 60) };
      }
      return null;
    };
    const cands = [];
    const candOf = new Map();
    const all = document.querySelectorAll("body *");
    for (let i = 0; i < all.length && i < 8000; i++) {
      const el = all[i];
      const t = el.localName;
      if (t === "script" || t === "style" || t === "template" || t === "noscript" || t === "link" || t === "meta" || t === "br") continue;
      const role = el.getAttribute("role") || "";
      const ariaModal = el.getAttribute("aria-modal") === "true";
      const nativeDialog = t === "dialog";
      const dialogRole = role === "dialog" || role === "alertdialog" || nativeDialog;
      if (nativeDialog && !el.open) continue;
      const cs = getComputedStyle(el);
      const fixed = cs.position === "fixed";
      if (!fixed && !dialogRole && !ariaModal) continue;
      const r = box(el, cs);
      if (!r) continue;
      const opacity = Number(cs.opacity);
      const buttons = [];
      for (const b of el.querySelectorAll(BTN)) {
        if (buttons.length >= 24) break;
        if (!box(b, getComputedStyle(b))) continue;
        buttons.push({ n: idx(b), tag: b.localName, text: clean(b.innerText || b.value || "", 40), label: clean(b.getAttribute("aria-label") || b.getAttribute("title") || "", 40), cls: clean(b.getAttribute("class"), 80) });
      }
      const inner = el.innerText || "";
      const c = {
        n: idx(el),
        tag: t,
        role,
        idcls: clean((el.getAttribute("id") || "") + " " + (el.getAttribute("class") || ""), 160),
        ariaModal,
        nativeModal: nativeDialog && el.matches(":modal"),
        dialogRole,
        fixed,
        x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
        area: vw * vh > 0 ? Math.round((clipArea(r) / (vw * vh)) * 1000) / 1000 : 0,
        z: parseInt(cs.zIndex, 10) || 0,
        bg: Math.round(alpha(cs.backgroundColor) * (Number.isFinite(opacity) ? opacity : 1) * 100) / 100,
        pointer: cs.pointerEvents !== "none",
        touchTop: r.top <= 2,
        touchBottom: r.bottom >= vh - 2,
        name: nameOf(el),
        text: clean(inner, 300),
        textLen: inner.trim().length,
        iframes: [...el.querySelectorAll("iframe")].slice(0, 3).map((f) => clean(f.getAttribute("src"), 200)),
        buttons,
        parent: -1,
        hits: 0,
        innerBlock: false,
        innerName: "",
      };
      candOf.set(el, cands.length);
      cands.push(c);
    }
    for (const c of cands) {
      if (!c.fixed || c.area < 0.9) continue;
      const inner = innerDialog(nodes[c.n], c);
      if (inner !== null) {
        c.innerBlock = true;
        c.innerName = inner.name;
      }
    }
    for (const c of cands) {
      for (let up = nodes[c.n].parentElement; up; up = up.parentElement) {
        const k = candOf.get(up);
        if (k !== undefined) { c.parent = k; break; }
      }
    }
    const containing = (hit) => {
      const out = [];
      if (!hit) return out;
      cands.forEach((c, k) => { if (nodes[c.n].contains(hit)) out.push(k); });
      return out;
    };
    // 3x3 grid of viewport points: which candidates are on top there.
    for (let gy = 0; gy < 3; gy++) for (let gx = 0; gx < 3; gx++) {
      for (const k of containing(document.elementFromPoint(((gx + 0.5) * vw) / 3, ((gy + 0.5) * vh) / 3))) cands[k].hits++;
    }
    const landmarks = [];
    for (const el of document.querySelectorAll("main, [role=main], form, nav, [role=navigation], table, h1")) {
      if (landmarks.length >= 10) break;
      if ([...candOf.keys()].some((c) => c.contains(el))) continue;
      const r = box(el, getComputedStyle(el));
      if (!r) continue;
      const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(vw, r.right), y1 = Math.min(vh, r.bottom);
      if (x1 <= x0 || y1 <= y0) continue;
      const id = el.getAttribute("id");
      landmarks.push({ name: el.localName + (id ? "#" + clean(id, 40) : ""), in: containing(document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2)) });
    }
    return { data: { vw, vh, cands, landmarks, nodes: info }, nodes };
  },

  classify(d) {
    const C = d.cands;
    const { labelOf, strictClose, isClose } = this.buttonRules();
    const CONSENT = /cookie|consent|gdpr/i;
    const CONSENT_ID = /consent|cookie|gdpr|onetrust|cmp-|privacy-banner/i;
    const TIMEOUT = /(会话|登录|登陆|session).{0,10}(超时|过期|失效|expir|time[ds]? ?out)|即将(超时|退出|过期)|自动(退出|登出|注销)|长时间未操作|还在吗|are you still there|still there\?|inactiv/i;
    const kindOf = (c) => {
      if (c.ariaModal || c.nativeModal || c.dialogRole) return "dialog";
      // 0.7.3: a role-less full-viewport mask wrapping a smaller dialog block.
      if (c.fixed && c.area >= 0.9 && c.innerBlock) return "dialog";
      if (!c.fixed) return null;
      if (c.iframes.length > 0 && c.area < 0.9) return "iframe-layer";
      if (c.area >= 0.9 && c.bg > 0 && c.textLen <= 40 && c.buttons.length === 0 && c.pointer) return "mask";
      if (c.w >= 0.6 * d.vw && c.h <= 0.5 * d.vh && (c.touchTop || c.touchBottom) && (CONSENT.test(c.text) || CONSENT_ID.test(c.idcls))) return "consent";
      if (c.area >= 0.9 && c.pointer) return "wrapper";
      return null;
    };
    const kinds = C.map(kindOf);
    const PRIMARY = new Set(["dialog", "iframe-layer", "consent"]);
    const ancestors = (k) => { const out = []; for (let p = C[k].parent, hops = 0; p >= 0 && hops < 64; p = C[p].parent, hops++) out.push(p); return out; };
    const prim = [];
    C.forEach((c, k) => { if (PRIMARY.has(kinds[k]) && !ancestors(k).some((a) => PRIMARY.has(kinds[a]))) prim.push(k); });
    const descendants = (k) => C.map((_, j) => j).filter((j) => ancestors(j).includes(k));
    const overlays = prim.map((k) => {
      const c = C[k];
      const inner = descendants(k).filter((j) => PRIMARY.has(kinds[j]));
      const wrappers = ancestors(k).filter((a) => kinds[a] === "wrapper");
      const root = wrappers.length > 0 ? wrappers[wrappers.length - 1] : k;
      const text = [c.name, c.text, ...inner.map((j) => C[j].name)].join(" ");
      let kind = kinds[k];
      const evidence = [];
      if (c.ariaModal || inner.some((j) => C[j].ariaModal)) evidence.push("aria-modal");
      if (c.nativeModal) evidence.push("<dialog> modal");
      if (c.dialogRole || inner.some((j) => C[j].dialogRole)) evidence.push("role=" + (c.role || C[inner.find((j) => C[j].dialogRole) ?? k].role || "dialog"));
      if (kind === "iframe-layer") evidence.push("iframe in a fixed layer");
      if (kind === "consent" || (kind === "dialog" && (CONSENT.test(c.text) || CONSENT_ID.test(c.idcls)))) { kind = "consent"; evidence.push("cookie / consent text"); }
      if (kind !== "consent" && TIMEOUT.test(text)) { kind = "timeout-prompt"; evidence.push("session-timeout text"); }
      if (root !== k) evidence.push("full-viewport wrapper");
      // 0.7.3: the role-less wrapper case (the layer itself is the dialog candidate).
      if (kind === "dialog" && c.fixed && c.area >= 0.9 && c.innerBlock) {
        if (!evidence.includes("full-viewport wrapper")) evidence.push("full-viewport wrapper");
        evidence.push("buttons in an inner block");
      }
      return { k, root, kind, inner, evidence, modal: c.ariaModal || c.nativeModal || inner.some((j) => C[j].ariaModal) || (C[root].area >= 0.9 && C[root].hits >= 5) };
    });
    // Masks outside every primary go to the primary drawn above them, else stand alone.
    const masks = C.map((_, j) => j).filter((j) => kinds[j] === "mask" && !ancestors(j).some((a) => PRIMARY.has(kinds[a])));
    const above = (a, b) => C[a].z > C[b].z || (C[a].z === C[b].z && C[a].n > C[b].n);
    const standalone = [];
    for (const m of masks) {
      let best = null;
      for (const o of overlays) if (above(o.root, m) && (best === null || above(o.root, best.root))) best = o;
      if (best === null) standalone.push(m);
      else if (best.mask === undefined) { best.mask = m; best.modal = true; best.evidence.push("mask " + Math.round(C[m].area * 100) + "%"); }
    }
    const out = [];
    for (const o of overlays) {
      const c = C[o.k];
      const members = [o.k, o.root, ...(o.mask === undefined ? [] : [o.mask])].filter((v, i, a) => a.indexOf(v) === i);
      const seen = new Set();
      const buttons = [];
      for (const j of [o.k, o.root, ...o.inner]) for (const b of C[j].buttons) if (!seen.has(b.n)) { seen.add(b.n); buttons.push(b); }
      let close = [];
      let choices = [];
      if (o.kind === "consent") choices = buttons.filter((b) => b.text || b.label);
      else if (o.kind === "timeout-prompt") { close = buttons.filter(strictClose); choices = buttons.filter((b) => !strictClose(b) && (b.text || b.label)); }
      else { close = buttons.filter(isClose); choices = buttons.filter((b) => !isClose(b) && (b.text || b.label)); }
      const name = c.name || o.inner.map((j) => C[j].name).find((x) => x) || c.innerName || c.text.slice(0, 30);
      const iframe = [c, ...o.inner.map((j) => C[j])].flatMap((x) => x.iframes)[0];
      out.push({
        n: c.n,
        kind: o.kind,
        role: c.role || (o.inner.length > 0 ? C[o.inner[0]].role : ""),
        name,
        modal: o.modal,
        coverage: Math.round(Math.max(...members.map((j) => C[j].area)) * 100),
        covers: d.landmarks.filter((l) => l.in.some((j) => members.includes(j))).map((l) => l.name),
        close: close.slice(0, 4).map((b) => ({ n: b.n, label: labelOf(b) })),
        choices: choices.slice(0, 4).map((b) => ({ n: b.n, label: labelOf(b) })),
        iframe: iframe === undefined ? null : iframe,
        evidence: o.evidence,
        members: members.map((j) => C[j].n),
      });
    }
    for (const m of standalone) {
      const c = C[m];
      out.push({ n: c.n, kind: "mask", role: c.role, name: c.text.slice(0, 30), modal: c.area >= 0.9, coverage: Math.round(c.area * 100), covers: d.landmarks.filter((l) => l.in.includes(m)).map((l) => l.name), close: [], choices: [], iframe: null, evidence: ["fixed mask " + Math.round(c.area * 100) + "%"], members: [c.n] });
    }
    out.sort((a, b) => Number(b.modal) - Number(a.modal) || b.coverage - a.coverage);
    return { overlays: out };
  },

  // Close-button rules shared by classify() and act("buttons").
  buttonRules() {
    const CLOSE_TEXT = /^(×|✕|✖|╳|x|X)$|^(关闭|關閉|取消|close|dismiss|稍后再说|以后再说|知道了|我知道了|cancel|no,? thanks|not now)$/i;
    const CLOSE_STRICT = /^(×|✕|✖|╳|x|X|关闭|關閉|close)$/i;
    const CLOSE_CLS = /(^|[\s_-])close|headerbtn/i;
    const labelOf = (b) => b.text || b.label || (CLOSE_CLS.test(b.cls) ? "close" : b.tag);
    const strictClose = (b) => CLOSE_STRICT.test(b.text) || CLOSE_STRICT.test(b.label) || (b.text === "" && b.label === "" && CLOSE_CLS.test(b.cls));
    const isClose = (b) => strictClose(b) || CLOSE_TEXT.test(b.text) || CLOSE_TEXT.test(b.label) || CLOSE_CLS.test(b.cls);
    return { labelOf, strictClose, isClose };
  },

  // act("buttons"): the visible buttons of the whole document `el` belongs to,
  // split into close buttons and other choices by the dialog rules. Used for
  // the document inside an iframe layer (0.4-I): its close button is not in
  // the layer's own document.
  docButtons(el) {
    const doc = el.ownerDocument || el;
    const view = doc.defaultView || window;
    const clean = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
    const visible = (b) => {
      const cs = view.getComputedStyle(b);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || Number(cs.opacity) === 0) return false;
      const r = b.getBoundingClientRect();
      return r.width >= 1 && r.height >= 1;
    };
    const BTN = "button, a[href], [role=button], input[type=button], input[type=submit], input[type=reset], [onclick], [class*=close], [class*=Close]";
    const nodes = [];
    const buttons = [];
    for (const b of doc.querySelectorAll(BTN)) {
      if (buttons.length >= 24) break;
      if (!visible(b)) continue;
      buttons.push({ n: nodes.length, tag: b.localName, text: clean(b.innerText || b.value || "", 40), label: clean(b.getAttribute("aria-label") || b.getAttribute("title") || "", 40), cls: clean(b.getAttribute("class"), 80) });
      nodes.push(b);
    }
    const { labelOf, isClose } = this.buttonRules();
    const close = buttons.filter(isClose).slice(0, 4).map((b) => ({ n: b.n, label: labelOf(b) }));
    const choices = buttons.filter((b) => !isClose(b) && (b.text || b.label)).slice(0, 4).map((b) => ({ n: b.n, label: labelOf(b) }));
    return this.pack({ close, choices }, nodes);
  },

  pack(data, nodes) {
    const keep = [];
    const map = new Map();
    const walk = (v) => {
      if (Array.isArray(v)) return v.map(walk);
      if (v === null || typeof v !== "object") return v;
      const o = {};
      for (const k of Object.keys(v)) {
        if (k === "members") continue;
        if (k === "n" && typeof v[k] === "number") {
          if (!map.has(v[k])) { map.set(v[k], keep.length); keep.push(nodes[v[k]]); }
          o.n = map.get(v[k]);
        } else o[k] = walk(v[k]);
      }
      return o;
    };
    return { data: walk(data), nodes: keep };
  },

  describe() {
    const col = this.collect();
    return this.pack(this.classify(col.data), col.nodes);
  },

  act(op, el) {
    if (op === "buttons") return el && el.isConnected ? this.docButtons(el) : { data: { close: [], choices: [] }, nodes: [] };
    if (op !== "covered") return { data: { error: "unknown op " + String(op) }, nodes: [] };
    if (!el || el.nodeType !== 1 || !el.isConnected) return { data: { covered: false, reason: "detached" }, nodes: [] };
    const col = this.collect();
    const r = this.classify(col.data);
    const nodes = col.nodes;
    const inGroup = (o, x) => o.members.some((m) => nodes[m] && nodes[m].contains(x));
    const vw = col.data.vw, vh = col.data.vh;
    const rect = el.getBoundingClientRect();
    const x0 = Math.max(0, rect.left), y0 = Math.max(0, rect.top), x1 = Math.min(vw, rect.right), y1 = Math.min(vh, rect.bottom);
    const inView = rect.width >= 1 && rect.height >= 1 && x1 > x0 && y1 > y0;
    const at = inView ? { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2) } : null;
    const hit = at === null ? null : document.elementFromPoint(at.x, at.y);
    for (const o of r.overlays) {
      if (inGroup(o, el)) continue;
      const blocked = hit !== null ? hit !== el && !el.contains(hit) && inGroup(o, hit) : o.modal && o.coverage >= 90;
      if (blocked) return this.pack({ covered: true, at, offscreen: at === null, overlay: o }, nodes);
    }
    return { data: { covered: false, at, overlays: r.overlays.length }, nodes: [] };
  },
})
