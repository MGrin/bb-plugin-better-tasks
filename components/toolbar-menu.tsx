// Shared trigger and dropdown placement for toolbar controls.
import type { ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { cn } from "../lib/utils";

export function ToolbarButton({ children, active, className, ...props }:
  React.ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button type="button" className={cn(
      "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted-foreground outline-none transition-colors hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-state-active data-[state=open]:text-foreground",
      active && "text-foreground", className,
    )} {...props}>{children}</button>
  );
}

export function Menu({ trigger, children, label, active, align = "start" }: {
  trigger: ReactNode; children: ReactNode; label: string; active?: boolean; align?: "start" | "end";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ToolbarButton aria-label={label} active={active}>{trigger}</ToolbarButton>
      </DropdownMenuTrigger>
      {/* Always open downward from the top toolbar, scrolling in the remaining space. */}
      <DropdownMenuContent align={align} side="bottom" avoidCollisions={false} collisionPadding={8}
        mobileTitle={label}
        className="max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height,70vh))] min-w-56 max-w-[min(24rem,calc(100vw-1rem))] overflow-y-auto">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
