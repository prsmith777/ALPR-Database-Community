"use client";

import { ArrowDownToLine, ArrowUpToLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  scrollMainToBottom,
  scrollMainToTop,
} from "@/lib/page-scroll.mjs";

export default function ResultsPagination({
  page,
  pageSize,
  total,
  onPreviousPage,
  onNextPage,
  position,
}) {
  const currentPage = Math.max(1, Number(page) || 1);
  const currentPageSize = Math.max(1, Number(pageSize) || 1);
  const totalResults = Math.max(0, Number(total) || 0);
  const firstResult = (currentPage - 1) * currentPageSize + 1;
  const lastResult = Math.min(currentPage * currentPageSize, totalResults);

  return (
    <div
      className={`flex flex-col gap-3 rounded-md border bg-card/40 p-3 sm:flex-row sm:items-center sm:justify-between ${
        position === "top" ? "mb-4" : "mt-4"
      }`}
      data-pagination-position={position}
    >
      <div className="text-xs text-muted-foreground sm:text-sm">
        {totalResults > 0
          ? `Showing ${firstResult} to ${lastResult} of ${totalResults} results`
          : "No results"}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={scrollMainToTop}>
          <ArrowUpToLine className="mr-1.5 h-4 w-4" />
          Top of page
        </Button>
        <Button variant="ghost" size="sm" onClick={scrollMainToBottom}>
          <ArrowDownToLine className="mr-1.5 h-4 w-4" />
          Bottom of page
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onPreviousPage}
          disabled={currentPage <= 1}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onNextPage}
          disabled={currentPage * currentPageSize >= totalResults}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
