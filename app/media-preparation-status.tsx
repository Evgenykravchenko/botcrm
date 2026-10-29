"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, LoaderCircle } from "lucide-react";
import type { ApiContentMedia } from "./api-client";

function remainingLabel(seconds: number) {
  if (seconds < 60) return `около ${Math.max(5, Math.ceil(seconds / 5) * 5)} сек`;
  if (seconds < 3600) return `около ${Math.ceil(seconds / 60)} мин`;
  return `около ${Math.ceil(seconds / 3600)} ч`;
}
function bytesLabel(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`; }

export function MediaPreparationStatus({ item }: { item: ApiContentMedia }) {
  const [now, setNow] = useState(() => Date.now());
  const progress = item.status === "processing" ? item.preparation : undefined;
  useEffect(() => {
    if (!progress) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [progress]);
  const ready = item.status === "ready" && item.canAttach !== false;
  const busy = item.status === "queued" || item.status === "processing";
  const age = progress ? Math.max(0, (now - Date.parse(progress.updatedAt)) / 1000) : 0;
  const fresh = age < 12;
  const percent = progress?.totalBytes ? Math.min(100, Math.floor(progress.transferredBytes / progress.totalBytes * 100)) : undefined;
  const labels = { draft: "Черновик", queued: "В очереди", processing: "Обрабатывается", ready: ready ? "Готов" : "Нужна повторная подготовка", error: "Ошибка" };
  const label = progress ? progress.stage === "connecting" ? "Подключаемся к Диску" : progress.stage === "finalizing" ? "Завершаем подготовку" : `Передаём файл${percent === undefined ? "" : ` · ${percent}%`}` : labels[item.status];
  const eta = progress?.stage === "transferring" && fresh && progress.etaSeconds != null ? remainingLabel(Math.max(1, progress.etaSeconds - age)) : "";
  return <span className={`media-preparation ${progress ? "has-progress" : ""}`}>
    <span className={`media-preparation-status ${ready ? "ready" : item.status === "error" ? "error" : ""}`} role="status">{busy ? <LoaderCircle size={12} className="spin"/> : ready ? <Check size={12}/> : <AlertCircle size={12}/>} {label}</span>
    {progress && <><progress aria-label="Передача файла" max={100} value={percent}/><span className="media-transfer-details">{progress.stage === "finalizing" ? "Файл передан, ждём подтверждения" : !fresh ? "Ожидаем обновления скорости…" : [eta, progress.bytesPerSecond ? `${bytesLabel(progress.bytesPerSecond)}/с` : "Измеряем скорость…"].filter(Boolean).join(" · ")}</span></>}
  </span>;
}
