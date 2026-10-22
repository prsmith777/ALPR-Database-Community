"use client";

import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { tableColumns, clampColumnWidth, columnWidthForKey, readColumnWidths, writeColumnWidths } from "@/lib/table-column-widths.mjs";

const ColumnContext = createContext(null);

export default function ResizablePlateTable({ surface, showStateCountry = false, children }) {
  const columns = useMemo(() => tableColumns(surface, showStateCountry), [surface, showStateCountry]);
  const [widths, setWidths] = useState(null);
  const [resizing, setResizing] = useState(false);
  const tableRef = useRef(null);
  const widthsRef = useRef(null);
  const drag = useRef(null);
  const instructionsId = useId();

  useEffect(() => {
    const saved = readColumnWidths(surface);
    widthsRef.current = saved;
    setWidths(saved);
  }, [surface]);

  const update = (next, persist = false) => {
    widthsRef.current = next;
    setWidths(next);
    if (persist) writeColumnWidths(surface, next);
  };

  // Freeze the rendered widths before changing one column so adjacent columns
  // do not redistribute the available space during a drag.
  const measure = () => {
    const next = { ...widthsRef.current };
    for (const column of columns) {
      const heading = tableRef.current?.querySelector(`[data-column-id="${column.id}"]`);
      const measured = heading?.getBoundingClientRect().width;
      next[column.id] = clampColumnWidth(column, measured || next[column.id] || column.width);
    }
    return next;
  };

  const finish = (event) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setResizing(false);
    writeColumnWidths(surface, widthsRef.current);
  };

  const context = {
    columns, widths, instructionsId,
    start(column, event) {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const base = measure();
      drag.current = { pointerId: event.pointerId, x: event.clientX, column, base };
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizing(true);
      update(base);
    },
    move(event) {
      const current = drag.current;
      if (!current || current.pointerId !== event.pointerId) return;
      const { column, base, x } = current;
      update({ ...base, [column.id]: clampColumnWidth(column, base[column.id] + event.clientX - x) });
    },
    finish,
    key(column, event) {
      const base = measure();
      const width = columnWidthForKey(column, base[column.id], event.key, event.shiftKey);
      if (width === null) return;
      event.preventDefault();
      event.stopPropagation();
      update({ ...base, [column.id]: width }, true);
    },
    reset(column) {
      update({ ...measure(), [column.id]: column.width }, true);
    },
  };
  const totalWidth = columns.reduce((sum, column) => sum + (widths?.[column.id] ?? column.width), 0);

  return <ColumnContext.Provider value={context}>
    <div className={cn("min-w-0 max-w-full", resizing && "select-none")}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5">
        <p id={instructionsId} className="text-xs text-muted-foreground">
          Drag header dividers to resize. <span className="sr-only">Focus a divider and use Left or Right arrows; hold Shift for larger steps. Home selects the minimum width and End the maximum. Double-click a divider to reset its column.</span>
        </p>
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => update(null, true)}>
          <RotateCcw className="h-3 w-3" />Reset widths
        </Button>
      </div>
      <Table ref={tableRef} className="resizable-plate-table table-fixed" style={{ width: totalWidth, minWidth: widths ? undefined : "100%" }}>
        <colgroup>{columns.map((column) => <col key={column.id} style={{ width: widths?.[column.id] ?? column.width }} />)}</colgroup>
        {children}
      </Table>
    </div>
  </ColumnContext.Provider>;
}

export function ResizableTableHead({ columnId, className, children }) {
  const context = useContext(ColumnContext);
  const column = context.columns.find((item) => item.id === columnId);
  const width = context.widths?.[columnId] ?? column.width;
  return <TableHead scope="col" data-column-id={columnId} className={cn("relative pr-4", className)}>
    <div className="min-w-0 max-w-full truncate" title={column.label}>{children}</div>
    <span
      role="separator" aria-orientation="vertical" aria-label={`Resize ${column.label} column`}
      aria-describedby={context.instructionsId} aria-valuemin={column.min} aria-valuemax={1000} aria-valuenow={width}
      tabIndex={0} title={`Drag to resize ${column.label}. Double-click to reset.`}
      className="absolute inset-y-0 right-0 z-10 flex w-3 cursor-col-resize touch-none items-center justify-center rounded-sm hover:bg-blue-500/20 focus-visible:bg-blue-500/20 focus-visible:outline-2 focus-visible:outline-blue-500"
      onPointerDown={(event) => context.start(column, event)} onPointerMove={context.move}
      onPointerUp={context.finish} onPointerCancel={context.finish} onLostPointerCapture={context.finish}
      onKeyDown={(event) => context.key(column, event)}
      onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => { event.stopPropagation(); context.reset(column); }}
    ><span className="h-5 w-px bg-zinc-300 dark:bg-zinc-600" /></span>
  </TableHead>;
}

export function TableValue({ children, className }) {
  return <span className={cn("block min-w-0 truncate", className)} title={(typeof children === "string" || typeof children === "number") ? String(children) : undefined}>{children}</span>;
}
