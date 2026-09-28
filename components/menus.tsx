// Status and priority pickers. A row renders a bare button; the dropdown is
// mounted only once someone opens it, so hundreds of rows scrolling past
// carry no menu machinery.
import { useState, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { PriorityGlyph, StatusGlyph } from "@/components/glyphs";
import {
  PRIORITIES,
  PRIORITY_LABEL,
  STATUS_LABEL,
  STATUSES,
  type Priority,
  type Status,
} from "@/lib/model";
import { cn } from "@/lib/utils";

/** Menu and 1–6 key order: the same order as the views. */
export const STATUS_MENU_ORDER: readonly Status[] = STATUSES;

function LazyMenu({
  label,
  trigger,
  triggerClassName,
  children,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  children: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  const className = cn(
    "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-state-active",
    triggerClassName,
  );
  if (!armed) {
    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        className={className}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          setArmed(true);
          setOpen(true);
        }}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            setArmed(true);
            setOpen(true);
          }
        }}
      >
        {trigger}
      </button>
    );
  }
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        aria-label={label}
        title={label}
        className={className}
        onClick={(event) => event.stopPropagation()}
      >
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44" onClick={(event) => event.stopPropagation()}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function StatusMenu({
  status,
  onChange,
  className,
}: {
  status: Status;
  onChange: (status: Status) => void;
  className?: string;
}) {
  return (
    <LazyMenu
      label={`Status: ${STATUS_LABEL[status]}`}
      trigger={<StatusGlyph status={status} />}
      triggerClassName={className}
    >
      {STATUS_MENU_ORDER.map((option, index) => (
        <DropdownMenuItem key={option} onSelect={() => option !== status && onChange(option)}>
          <StatusGlyph status={option} />
          <span className="flex-1">{STATUS_LABEL[option]}</span>
          {option === status ? <Icon name="Check" className="size-3.5" /> : null}
          <DropdownMenuShortcut>{index + 1}</DropdownMenuShortcut>
        </DropdownMenuItem>
      ))}
    </LazyMenu>
  );
}

export function PriorityMenu({
  priority,
  onChange,
  className,
}: {
  priority: Priority;
  onChange: (priority: Priority) => void;
  className?: string;
}) {
  return (
    <LazyMenu
      label={`Priority: ${PRIORITY_LABEL[priority]}`}
      trigger={<PriorityGlyph priority={priority} />}
      triggerClassName={className}
    >
      {PRIORITIES.map((option, index) => (
        <DropdownMenuItem key={option} onSelect={() => option !== priority && onChange(option)}>
          <PriorityGlyph priority={option} />
          <span className="flex-1">{PRIORITY_LABEL[option]}</span>
          {option === priority ? <Icon name="Check" className="size-3.5" /> : null}
          <DropdownMenuShortcut>⇧{index + 1}</DropdownMenuShortcut>
        </DropdownMenuItem>
      ))}
    </LazyMenu>
  );
}
