import { useEffect, useState } from "react";

/** Instagram profile picture with a coloured initial as fallback (no picture yet, or the CDN link expired). */
export function UserAvatar({ url, name, size = 36 }: { url?: string | null; name?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const letter = (name ?? "").replace(/[^A-Za-z0-9]/g, "")[0]?.toUpperCase() ?? "?";
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (url && !broken)
    return <img src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="shrink-0 rounded-full bg-[var(--surface-2)] object-cover ring-2 ring-[var(--surface)]" style={style} />;
  return (
    <div className="flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 via-fuchsia-600 to-orange-500 font-bold text-white" style={style} aria-hidden>
      {letter}
    </div>
  );
}
