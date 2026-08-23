"use client";

import { Check, Leaf, Moon, Palette, Sparkles, Sun, Sunrise, Waves } from "lucide-react";
import { useEffect, useRef, useState, type ComponentType } from "react";

export type ThemeName = "light" | "dark" | "ocean" | "sage" | "sand" | "plum";

type ThemeOption = {
  value: ThemeName;
  label: string;
  detail: string;
  colors: [string, string, string];
  icon: ComponentType<{ size?: number }>;
  dark: boolean;
};

export const themeOptions: ThemeOption[] = [
  { value: "light", label: "Светлая", detail: "Чистая и нейтральная", colors: ["#ffffff", "#f4f6fa", "#6857df"], icon: Sun, dark: false },
  { value: "dark", label: "Тёмная", detail: "Спокойная для вечера", colors: ["#171b25", "#10131b", "#6857df"], icon: Moon, dark: true },
  { value: "ocean", label: "Океан", detail: "Глубокая сине-бирюзовая", colors: ["#102331", "#0b1822", "#55b8d7"], icon: Waves, dark: true },
  { value: "sage", label: "Шалфей", detail: "Мягкая природная", colors: ["#fbfdf9", "#f1f5f0", "#5f8065"], icon: Leaf, dark: false },
  { value: "sand", label: "Песок", detail: "Тёплая кремовая", colors: ["#fffdf7", "#f7f2e8", "#ad7552"], icon: Sunrise, dark: false },
  { value: "plum", label: "Слива", detail: "Глубокая фиолетовая", colors: ["#211926", "#17121c", "#b47bd1"], icon: Sparkles, dark: true },
];

export function isThemeName(value: string | null): value is ThemeName {
  return themeOptions.some((option) => option.value === value);
}

export function isDarkTheme(value: ThemeName) {
  return themeOptions.find((option) => option.value === value)?.dark ?? false;
}

export function ThemePicker({ value, onChange }: { value: ThemeName; onChange: (value: ThemeName) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = themeOptions.find((option) => option.value === value) ?? themeOptions[0];

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <div className="theme-picker" ref={rootRef}>
    <button className={`icon-button theme-picker-trigger ${open ? "active" : ""}`} type="button" onClick={() => setOpen((current) => !current)} aria-label={`Тема: ${selected.label}`} aria-haspopup="dialog" aria-expanded={open} title={`Тема: ${selected.label}`}>
      <Palette size={18} />
      <i style={{ background: selected.colors[2] }} />
    </button>
    {open && <div className="theme-picker-popover" role="dialog" aria-label="Выбор темы">
      <header><span><b>Оформление</b><small>Выберите комфортную палитру</small></span></header>
      <div className="theme-picker-grid">
        {themeOptions.map((option) => {
          const Icon = option.icon;
          const active = option.value === value;
          return <button key={option.value} type="button" className={active ? "active" : ""} onClick={() => { onChange(option.value); setOpen(false); }} aria-pressed={active}>
            <span className="theme-preview" style={{ background: option.colors[1] }}>
              <i style={{ background: option.colors[0] }} />
              <i style={{ background: option.colors[2] }} />
            </span>
            <span className="theme-option-copy"><b><Icon size={14} />{option.label}</b><small>{option.detail}</small></span>
            {active && <Check className="theme-option-check" size={15} />}
          </button>;
        })}
      </div>
    </div>}
  </div>;
}
