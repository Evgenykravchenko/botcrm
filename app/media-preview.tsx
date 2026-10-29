"use client";
/* eslint-disable @next/next/no-img-element -- Authenticated Blob thumbnails need native dimensions for the video aspect ratio. */

import { useEffect, useRef, useState } from "react";
import { AlertCircle, LoaderCircle, Play, X } from "lucide-react";
import { botcrmApi } from "./api-client";

export function useDiskPreview(botSlug: string, path: string, enabled = true) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setUrl(""); setFailed(false);
    if (!enabled || !botSlug || !path) return;
    let active = true;
    let objectUrl = "";
    void botcrmApi.contentDiskPreview(botSlug, path).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [botSlug, path, enabled]);
  return { url, failed };
}

export function DiskVideoPlayer({ botSlug, path, name, poster, fallbackUrl }: { botSlug: string; path: string; name: string; poster?: string; fallbackUrl?: string }) {
  const [ratio, setRatio] = useState(16 / 9);
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => { setSource(""); setError(false); setRatio(16 / 9); }, [botSlug, path]);
  async function play() {
    setLoading(true); setError(false);
    try { setSource((await botcrmApi.contentVideoPlayback(botSlug, path)).url); }
    catch { setError(true); }
    finally { setLoading(false); }
  }
  return <div className={`disk-video-player ${ratio < .85 ? "portrait" : "landscape"}`} style={{ aspectRatio: String(ratio), ...(ratio < .85 ? { maxWidth: `min(100%, ${70 * ratio}vh)` } : {}) }}>
    {source ? <video controls autoPlay playsInline preload="metadata" poster={poster} src={source} onLoadedMetadata={(event) => { const video = event.currentTarget; if (video.videoWidth && video.videoHeight) setRatio(video.videoWidth / video.videoHeight); }} onError={() => { setSource(""); setError(true); }}/>
      : <button type="button" aria-label={`Воспроизвести ${name}`} disabled={loading || !botSlug || !path} onClick={() => void play()}>{poster && <img src={poster} alt={name} onLoad={(event) => { const image = event.currentTarget; if (image.naturalWidth && image.naturalHeight) setRatio(image.naturalWidth / image.naturalHeight); }}/>}<i>{loading ? <LoaderCircle className="spin" size={24}/> : <Play size={26} fill="currentColor"/>}</i></button>}
    {error && <span className="video-playback-error"><AlertCircle size={14}/>Не удалось воспроизвести в браузере.{fallbackUrl && <a href={fallbackUrl} target="_blank" rel="noreferrer">Открыть видео</a>}</span>}
  </div>;
}

export function VideoPreviewDialog({ botSlug, path, name, poster, close }: { botSlug: string; path: string; name: string; poster?: string; close: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeButton.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [close]);
  return <div className="modal-backdrop video-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="modal video-preview-dialog" role="dialog" aria-modal="true" aria-label={name}><header><h2>{name}</h2><button ref={closeButton} className="icon-button" type="button" aria-label="Закрыть видео" onClick={close}><X size={19}/></button></header><DiskVideoPlayer botSlug={botSlug} path={path} name={name} poster={poster}/></section></div>;
}
