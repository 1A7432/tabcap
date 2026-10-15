// Test-only page script: describe() lists elements with an fui- class.
({
  describe() {
    const els = [...document.querySelectorAll("[class^='fui-']")].slice(0, 8);
    return { data: { widgets: els.map((e, n) => ({ n, cls: e.getAttribute("class") })) }, nodes: els };
  },
  act(op, el) {
    return { data: { op, tag: el.localName }, nodes: [] };
  },
})
