"use client";

import { ChangeEvent, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, Link2, MousePointerClick, Plus, Trash2, X } from "lucide-react";
import { ApiCampaignButton, ApiChannel, ApiMediaUpload, botcrmApi } from "../api-client";
import { AppSelect } from "./app-select";

export type CampaignMedia = ApiMediaUpload & { previewUrl: string };

export const campaignRichCapabilities: Record<ApiChannel, { buttonLimit: number; perRow: number; imageLimit: number; links: boolean; note: string }> = {
  telegram: { buttonLimit: 100, perRow: 8, imageLimit: 10, links: true, note: "Кнопки, ссылки и до 10 изображений" },
  vk: { buttonLimit: 40, perRow: 5, imageLimit: 0, links: true, note: "Кнопки и ссылки; изображения требуют отдельной загрузки VK" },
  whatsapp: { buttonLimit: 3, perRow: 3, imageLimit: 1, links: false, note: "До 3 быстрых ответов и одно изображение; ссылки — только в одобренных шаблонах" },
  avito: { buttonLimit: 0, perRow: 0, imageLimit: 0, links: false, note: "Кнопки и изображения для этого подключения недоступны" },
  api: { buttonLimit: 100, perRow: 10, imageLimit: 10, links: true, note: "Кнопки, ссылки и до 10 изображений передаются в webhook" },
};

export function validateCampaignRichContent(channel: ApiChannel, buttons: ApiCampaignButton[], media: CampaignMedia[]) {
  const capability = campaignRichCapabilities[channel];
  if (buttons.length > capability.buttonLimit) return `Для канала доступно не более ${capability.buttonLimit} кнопок`;
  if (media.length > capability.imageLimit) return `Для канала доступно не более ${capability.imageLimit} изображений`;
  if (!capability.links && buttons.some((button) => button.type === "url")) return "Ссылочные кнопки недоступны для выбранного формата канала";
  for (const button of buttons.filter((item) => item.type === "url")) { try { const url = new URL(button.value); if (!["http:", "https:"].includes(url.protocol)) return "Ссылка кнопки должна начинаться с http:// или https://"; } catch { return "Укажите корректную ссылку для кнопки"; } }
  if (buttons.some((button) => !button.text.trim() || !button.value.trim())) return "Заполните текст и действие каждой кнопки";
  const rows = new Map<number, number>(); buttons.forEach((button) => rows.set(button.row, (rows.get(button.row) ?? 0) + 1));
  if ([...rows.values()].some((count) => count > capability.perRow)) return `В одном ряду можно разместить не более ${capability.perRow} кнопок`;
  return "";
}

export function CampaignRichContent({ channel, buttons, onButtonsChange, media, onMediaChange, previewText }: { channel: ApiChannel; buttons: ApiCampaignButton[]; onButtonsChange: (buttons: ApiCampaignButton[]) => void; media: CampaignMedia[]; onMediaChange: (media: CampaignMedia[]) => void; previewText: string }) {
  const capability = campaignRichCapabilities[channel];
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const validation = validateCampaignRichContent(channel, buttons, media);
  const maxRow = Math.max(0, ...buttons.map((button) => button.row));
  const rowOptions = Array.from({ length: Math.max(3, maxRow + 2) }, (_, index) => ({ value: String(index), label: `Ряд ${index + 1}`, detail: index === 0 ? "Сразу под сообщением" : "Ниже предыдущего ряда" }));

  function addButton() {
    if (buttons.length >= capability.buttonLimit) return;
    const lastRow = buttons.at(-1)?.row ?? 0;
    const inLastRow = buttons.filter((button) => button.row === lastRow).length;
    const row = inLastRow < capability.perRow ? lastRow : lastRow + 1;
    onButtonsChange([...buttons, { id: crypto.randomUUID(), text: "Подробнее", type: "callback", value: "details", row }]);
  }
  function updateButton(id: string | undefined, patch: Partial<ApiCampaignButton>) { onButtonsChange(buttons.map((button) => button.id === id ? { ...button, ...patch } : button)); }
  function moveButton(index: number, direction: -1 | 1) { const target = index + direction; if (target < 0 || target >= buttons.length) return; const next = [...buttons]; [next[index], next[target]] = [next[target], next[index]]; onButtonsChange(next); }
  function removeMedia(id: string) { const item = media.find((image) => image.id === id); if (item) URL.revokeObjectURL(item.previewUrl); onMediaChange(media.filter((image) => image.id !== id)); }
  async function uploadImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/")).slice(0, Math.max(0, capability.imageLimit - media.length));
    event.target.value = ""; if (!files.length) return;
    setUploading(true); setError("");
    try {
      const uploaded: CampaignMedia[] = [];
      for (const file of files) uploaded.push({ ...(await botcrmApi.uploadAttachment(file)), previewUrl: URL.createObjectURL(file) });
      onMediaChange([...media, ...uploaded]);
    } catch (uploadError) { setError(uploadError instanceof Error ? uploadError.message : "Не удалось загрузить изображение"); }
    finally { setUploading(false); }
  }
  const grouped = [...new Set(buttons.map((button) => button.row))].sort((left, right) => left - right).map((row) => buttons.filter((button) => button.row === row));

  return <section className="campaign-rich-editor">
    <header><div><b>Кнопки и изображения</b><small>{capability.note}</small></div><span>{channel.toUpperCase()}</span></header>
    <div className="campaign-rich-actions">
      <button type="button" disabled={!capability.buttonLimit || buttons.length >= capability.buttonLimit} onClick={addButton}><Plus size={14} />Добавить кнопку</button>
      <button type="button" disabled={!capability.imageLimit || media.length >= capability.imageLimit || uploading} onClick={() => fileRef.current?.click()}><ImagePlus size={14} />{uploading ? "Загрузка…" : "Добавить фото"}</button>
      <input ref={fileRef} hidden type="file" accept="image/*" multiple onChange={(event) => void uploadImages(event)} />
    </div>
    {!!media.length && <div className="campaign-media-grid">{media.map((image) => <figure key={image.id}>{image.previewUrl ? <img src={image.previewUrl} alt={image.filename} /> : <div className="campaign-media-placeholder"><ImagePlus size={20} /><span>Фото сохранено</span></div>}<button type="button" aria-label={`Удалить ${image.filename}`} onClick={() => removeMedia(image.id)}><X size={13} /></button><figcaption>{image.filename}</figcaption></figure>)}</div>}
    {!!buttons.length && <div className="campaign-button-list">{buttons.map((button, index) => <article key={button.id}>
      <div className="campaign-button-order"><button type="button" disabled={index === 0} aria-label="Поднять кнопку" onClick={() => moveButton(index, -1)}><ArrowUp size={13} /></button><button type="button" disabled={index === buttons.length - 1} aria-label="Опустить кнопку" onClick={() => moveButton(index, 1)}><ArrowDown size={13} /></button></div>
      <label><span>Текст кнопки</span><input value={button.text} maxLength={64} onChange={(event) => updateButton(button.id, { text: event.target.value })} /></label>
      <label><span>Тип действия</span><AppSelect ariaLabel={`Тип кнопки ${index + 1}`} value={button.type} onValueChange={(value) => updateButton(button.id, { type: value as "callback" | "url", value: value === "url" ? "https://" : "details" })} options={[{ value: "callback", label: "Быстрый ответ", detail: "Передать действие боту", icon: <MousePointerClick size={15} /> }, ...(capability.links ? [{ value: "url", label: "Открыть ссылку", detail: "Перейти на сайт", icon: <Link2 size={15} /> }] : [])]} /></label>
      <label><span>{button.type === "url" ? "Ссылка" : "Значение действия"}</span><input type={button.type === "url" ? "url" : "text"} value={button.value} placeholder={button.type === "url" ? "https://example.com" : "buy_pro"} onChange={(event) => updateButton(button.id, { value: event.target.value })} /></label>
      <label><span>Расположение</span><AppSelect ariaLabel={`Ряд кнопки ${index + 1}`} value={String(button.row)} onValueChange={(value) => updateButton(button.id, { row: Number(value) })} options={rowOptions} /></label>
      <button type="button" className="campaign-button-delete" aria-label="Удалить кнопку" onClick={() => onButtonsChange(buttons.filter((item) => item.id !== button.id))}><Trash2 size={15} /></button>
    </article>)}</div>}
    {(error || validation) && <p className="campaign-rich-error">{error || validation}</p>}
    <div className="campaign-message-mock"><div className={`campaign-mock-media count-${Math.min(media.length, 4)}`}>{media.map((image) => image.previewUrl ? <img key={image.id} src={image.previewUrl} alt="" /> : <div className="campaign-media-placeholder mock" key={image.id}><ImagePlus size={18} /></div>)}</div><p>{previewText}</p>{grouped.map((row, index) => <div className="campaign-mock-buttons" key={index}>{row.map((button) => <span key={button.id}>{button.type === "url" && <Link2 size={11} />}{button.text || "Кнопка"}</span>)}</div>)}</div>
  </section>;
}
