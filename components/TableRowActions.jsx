"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuPortal } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function ActionLabel({ action }) {
  const Icon = action.icon;
  return <><Icon className={cn("h-4 w-4 shrink-0", action.iconClassName)} /><span>{action.label}</span></>;
}

function TagItems({ items }) {
  return items.length ? items.map((item) => <DropdownMenuItem key={item.id} onSelect={item.onSelect}>
    <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />{item.label}
  </DropdownMenuItem>) : <DropdownMenuItem disabled>No tags available</DropdownMenuItem>;
}

export default function TableRowActions({ plateNumber, actions }) {
  const container = useRef(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const visibleActions = actions.filter(Boolean);
  const expanded = availableWidth >= visibleActions.length * 34 - 2;

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setAvailableWidth(entry.contentRect.width));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);

  return <div ref={container} className="flex w-full min-w-0 justify-end" data-action-layout={expanded ? "icons" : "menu"}>
    {expanded ? <div className="flex items-center gap-0.5">
      {visibleActions.map((action) => {
        const Icon = action.icon;
        const className = cn("h-8 w-8 shrink-0 p-0", (action.destructive || action.active) && "text-red-500 hover:text-red-700");
        const iconButton = action.href
          ? <Button variant="ghost" size="icon" className={className} asChild><Link href={action.href} aria-label={action.ariaLabel}><Icon className={cn("h-4 w-4", action.iconClassName)} /></Link></Button>
          : <Button type="button" variant="ghost" size="icon" className={className} aria-label={action.ariaLabel} disabled={action.disabled} onClick={action.items ? undefined : action.onSelect}><Icon className={cn("h-4 w-4", action.iconClassName)} /></Button>;
        return action.items ? <DropdownMenu key={action.id}>
          <Tooltip><TooltipTrigger asChild><DropdownMenuTrigger asChild>{iconButton}</DropdownMenuTrigger></TooltipTrigger><TooltipContent>{action.label}</TooltipContent></Tooltip>
          <DropdownMenuContent align="end"><TagItems items={action.items} /></DropdownMenuContent>
        </DropdownMenu> : <Tooltip key={action.id}><TooltipTrigger asChild>{action.disabled ? <span tabIndex={0} aria-label={action.label}>{iconButton}</span> : iconButton}</TooltipTrigger><TooltipContent>{action.label}</TooltipContent></Tooltip>;
      })}
    </div> : <DropdownMenu>
      <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={`Actions for ${plateNumber}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {visibleActions.map((action) => action.items ? <DropdownMenuSub key={action.id}>
          <DropdownMenuSubTrigger><ActionLabel action={action} /></DropdownMenuSubTrigger>
          <DropdownMenuPortal><DropdownMenuSubContent><TagItems items={action.items} /></DropdownMenuSubContent></DropdownMenuPortal>
        </DropdownMenuSub> : <DropdownMenuItem key={action.id} disabled={action.disabled} onSelect={action.href ? undefined : action.onSelect} className={cn((action.destructive || action.active) && "text-red-500 focus:text-red-500")} asChild={Boolean(action.href)}>
          {action.href ? <Link href={action.href}><ActionLabel action={action} /></Link> : <ActionLabel action={action} />}
        </DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>}
  </div>;
}
