"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type AppSelectOption = {
  value: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  color?: string;
  disabled?: boolean;
};

type AppSelectProps = {
  value: string;
  options: AppSelectOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  compact?: boolean;
  matchTriggerWidth?: boolean;
  menuWidth?: number;
  menuAlign?: "start" | "end";
  disabled?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
};

type MenuPosition = { left: number; top: number; width: number; maxHeight: number };

export function AppSelect({
  value,
  options,
  onValueChange,
  ariaLabel,
  placeholder = "Выберите",
  className = "",
  compact = false,
  matchTriggerWidth = false,
  menuWidth,
  menuAlign = "start",
  disabled = false,
  searchable = false,
  searchPlaceholder = "Поиск…",
}: AppSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [portalRoot, setPortalRoot] = useState<Element | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const selected = options.find((option) => option.value === value);
  const normalizedQuery = query.trim().toLocaleLowerCase("ru-RU");
  const filteredOptions = normalizedQuery
    ? options.filter((option) => `${option.label} ${option.detail ?? ""}`.toLocaleLowerCase("ru-RU").includes(normalizedQuery))
    : options;

  const placeMenu = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 10;
    const desiredHeight = Math.min(330, options.length * 48 + (searchable ? 62 : 12));
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
    const spaceAbove = rect.top - viewportPadding;
    const openAbove = spaceBelow < Math.min(desiredHeight, 180) && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.min(desiredHeight, openAbove ? spaceAbove - 8 : spaceBelow - 8));
    const width = menuWidth ?? (matchTriggerWidth ? rect.width : Math.max(rect.width, 220));
    const preferredLeft = menuAlign === "end" ? rect.right - width : rect.left;
    const left = Math.min(preferredLeft, window.innerWidth - width - viewportPadding);
    setPosition({
      left: Math.max(viewportPadding, left),
      top: openAbove ? Math.max(viewportPadding, rect.top - maxHeight - 7) : rect.bottom + 7,
      width,
      maxHeight,
    });
  }, [matchTriggerWidth, menuAlign, menuWidth, options.length, searchable]);

  useLayoutEffect(() => {
    if (!open) return;
    setPortalRoot(triggerRef.current?.closest(".app-shell") ?? document.body);
    placeMenu();
  }, [open, placeMenu]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const reposition = () => placeMenu();
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, placeMenu]);

  useEffect(() => {
    if (!open || !searchable) return;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, searchable]);

  const choose = (option: AppSelectOption) => {
    if (option.disabled) return;
    onValueChange(option.value);
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  };

  return (
    <div className={`app-select ${compact ? "compact" : ""} ${open ? "open" : ""} ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className="app-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => {
          if (current) setQuery("");
          return !current;
        })}
      >
        <span className="app-select-leading" style={selected?.color ? { color: selected.color } : undefined}>
          {selected?.icon ?? (selected?.color ? <i style={{ background: selected.color }} /> : null)}
        </span>
        <span className="app-select-value">
          <b>{selected?.label ?? placeholder}</b>
          {selected?.detail && <small>{selected.detail}</small>}
        </span>
        <ChevronDown className="app-select-chevron" size={16} />
      </button>

      {open && position && portalRoot && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          className="app-select-menu"
          role="listbox"
          aria-label={ariaLabel}
          style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}
        >
          {searchable && <div className="app-select-search"><Search size={15} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={searchPlaceholder} aria-label={searchPlaceholder} /></div>}
          {filteredOptions.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                disabled={option.disabled}
                onClick={() => choose(option)}
              >
                <span className="app-select-option-icon" style={option.color ? { color: option.color } : undefined}>
                  {option.icon ?? (option.color ? <i style={{ background: option.color }} /> : null)}
                </span>
                <span className="app-select-option-copy">
                  <b>{option.label}</b>
                  {option.detail && <small>{option.detail}</small>}
                </span>
                <span className="app-select-check">{active && <Check size={16} />}</span>
              </button>
            );
          })}
          {filteredOptions.length === 0 && <div className="app-select-empty">Ничего не найдено</div>}
        </div>,
        portalRoot,
      )}
    </div>
  );
}
