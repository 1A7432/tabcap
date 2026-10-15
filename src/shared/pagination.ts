/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Derived from chrome-devtools-mcp src/utils/pagination.ts (paginate) and the
// pagination lines of src/McpResponse.ts (#dataWithPagination), commit
// e9000381f414bf5fd5fb83a9164fabfb8e0987b3, read 2026-10-15.
// Modifications for tabcap (2026-10-15): the default page size is 100 instead
// of 20; PaginationOptions is declared here; `paginationLines` returns the
// result texts instead of pushing them onto a response; formatted with the
// project's style.

export interface PaginationOptions {
  pageSize?: number;
  pageIdx?: number;
}

export interface PaginationResult<Item> {
  items: readonly Item[];
  currentPage: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startIndex: number;
  endIndex: number;
  invalidPage: boolean;
}

export const DEFAULT_PAGE_SIZE = 100;

export function paginate<Item>(items: readonly Item[], options?: PaginationOptions): PaginationResult<Item> {
  const total = items.length;

  if (!options || noPaginationOptions(options)) {
    return {
      items,
      currentPage: 0,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
      startIndex: 0,
      endIndex: total,
      invalidPage: false,
    };
  }

  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const { currentPage, invalidPage } = resolvePageIndex(options.pageIdx, totalPages);

  const startIndex = currentPage * pageSize;
  const pageItems = items.slice(startIndex, startIndex + pageSize);
  const endIndex = startIndex + pageItems.length;

  return {
    items: pageItems,
    currentPage,
    totalPages,
    hasNextPage: currentPage < totalPages - 1,
    hasPreviousPage: currentPage > 0,
    startIndex,
    endIndex,
    invalidPage,
  };
}

function noPaginationOptions(options: PaginationOptions): boolean {
  return options.pageSize === undefined && options.pageIdx === undefined;
}

function resolvePageIndex(
  pageIdx: number | undefined,
  totalPages: number,
): {
  currentPage: number;
  invalidPage: boolean;
} {
  if (pageIdx === undefined) {
    return { currentPage: 0, invalidPage: false };
  }

  if (pageIdx < 0 || pageIdx >= totalPages) {
    return { currentPage: 0, invalidPage: true };
  }

  return { currentPage: pageIdx, invalidPage: false };
}

/**
 * The result texts of chrome-devtools-mcp's paginated lists:
 * "Invalid page number provided. Showing first page.",
 * "Showing a-b of n (Page x of y).", "Next page: i", "Previous page: i"
 * (the last two only when paging options were given).
 */
export function paginationLines<Item>(total: number, r: PaginationResult<Item>, paged: boolean): string[] {
  const response: string[] = [];
  if (r.invalidPage) {
    response.push("Invalid page number provided. Showing first page.");
  }
  const displayStartIndex = total === 0 ? 0 : r.startIndex + 1;
  response.push(`Showing ${displayStartIndex}-${r.endIndex} of ${total} (Page ${r.currentPage + 1} of ${r.totalPages}).`);
  if (paged) {
    if (r.hasNextPage) {
      response.push(`Next page: ${r.currentPage + 1}`);
    }
    if (r.hasPreviousPage) {
      response.push(`Previous page: ${r.currentPage - 1}`);
    }
  }
  return response;
}
