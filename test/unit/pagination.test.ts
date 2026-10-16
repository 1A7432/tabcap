// Paging (docs/08 §5): chrome-devtools-mcp's paginate() and its texts, and how
// `net list` / `console list` turn their options into a page.

import { describe, expect, test } from "bun:test";
import { paginate, paginationLines } from "../../src/shared/pagination.ts";
import { pageOf, parsePaging } from "../../src/daemon/tools/netquery.ts";
import { TabcapError } from "../../src/shared/envelope.ts";

const items = Array.from({ length: 23 }, (_, i) => i);

describe("paginate (chrome-devtools-mcp src/utils/pagination.ts)", () => {
  test("no options: everything, one page", () => {
    const r = paginate(items);
    expect(r).toMatchObject({ currentPage: 0, totalPages: 1, hasNextPage: false, hasPreviousPage: false, startIndex: 0, endIndex: 23, invalidPage: false });
    expect(r.items).toEqual(items);
    expect(paginate(items, {})).toMatchObject({ totalPages: 1, endIndex: 23 });
  });

  test("page size alone starts at page 0; the default size is 100", () => {
    expect(paginate(items, { pageSize: 10 })).toMatchObject({ items: items.slice(0, 10), currentPage: 0, totalPages: 3, hasNextPage: true });
    expect(paginate(items, { pageIdx: 0 })).toMatchObject({ totalPages: 1, endIndex: 23 });
  });

  test("the last page is short; an out-of-range page shows the first and says so", () => {
    expect(paginate(items, { pageSize: 10, pageIdx: 2 })).toMatchObject({ items: [20, 21, 22], currentPage: 2, hasNextPage: false, hasPreviousPage: true, startIndex: 20, endIndex: 23 });
    expect(paginate(items, { pageSize: 10, pageIdx: 3 })).toMatchObject({ currentPage: 0, invalidPage: true, items: items.slice(0, 10) });
    expect(paginate([], { pageSize: 10 })).toMatchObject({ totalPages: 1, items: [], endIndex: 0 });
  });

  test("result texts", () => {
    expect(paginationLines(23, paginate(items, { pageSize: 10, pageIdx: 1 }), true)).toEqual(["Showing 11-20 of 23 (Page 2 of 3).", "Next page: 2", "Previous page: 0"]);
    expect(paginationLines(23, paginate(items, { pageSize: 10, pageIdx: 7 }), true)).toEqual(["Invalid page number provided. Showing first page.", "Showing 1-10 of 23 (Page 1 of 3).", "Next page: 1"]);
    expect(paginationLines(0, paginate([]), false)).toEqual(["Showing 0-0 of 0 (Page 1 of 1)."]);
    expect(paginationLines(23, paginate(items), false)).toEqual(["Showing 1-23 of 23 (Page 1 of 1)."]);
  });
});

describe("paging options of net list / console list", () => {
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof TabcapError ? e.code : "other";
    }
    return "none";
  };

  test("no paging option → page 0 of 100 (owner, 0.4); --page-size 0 → everything; the removed --limit / --offset keys change nothing", () => {
    expect(parsePaging({}, "net list")).toEqual({ mode: "page", size: 100, idx: null });
    expect(parsePaging({ pageSize: 10 }, "net list")).toEqual({ mode: "page", size: 10, idx: null });
    expect(parsePaging({ pageIdx: 2 }, "net list")).toEqual({ mode: "page", size: 100, idx: 2 });
    expect(parsePaging({ pageSize: 0 }, "net list")).toEqual({ mode: "all" });
    expect(parsePaging({ pageSize: 0, pageIdx: 0 }, "console list")).toEqual({ mode: "all" });
    expect(parsePaging({ limit: 25, offset: 50 }, "net list")).toEqual({ mode: "page", size: 100, idx: null });
  });

  test("bad values are usage errors", () => {
    expect(code(() => parsePaging({ pageSize: -1 }, "net list"))).toBe("usage");
    expect(code(() => parsePaging({ pageSize: 0, pageIdx: 1 }, "net list"))).toBe("usage");
    expect(code(() => parsePaging({ pageSize: 1001 }, "net list"))).toBe("usage");
    expect(code(() => parsePaging({ pageIdx: -1 }, "net list"))).toBe("usage");
    expect(code(() => parsePaging({ pageIdx: 1.5 }, "net list"))).toBe("usage");
    expect(code(() => parsePaging({ pageSize: "x" }, "net list"))).toBe("usage");
  });

  test("pageOf: next page index and the texts; the 0.3 offset / limit / nextOffset fields are gone", () => {
    const p = pageOf(items, { mode: "page", size: 10, idx: 1 });
    expect(p).toMatchObject({ rows: items.slice(10, 20), pageSize: 10, pageIdx: 1, totalPages: 3, nextPageIdx: 2, invalidPage: false });
    expect(p.pagination[0]).toBe("Showing 11-20 of 23 (Page 2 of 3).");
    expect(pageOf(items, { mode: "page", size: 10, idx: 2 })).toMatchObject({ nextPageIdx: null });
    expect(pageOf(items, { mode: "all" })).toMatchObject({ rows: items, pageSize: null, nextPageIdx: null, totalPages: 1 });
    for (const k of ["offset", "limit", "nextOffset"]) expect(Object.keys(p)).not.toContain(k);
  });
});
