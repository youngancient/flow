export function XPreview({ body, hashtags }: { body: string; hashtags: string[] }) {
  const charCount = body.length + (hashtags.length ? hashtags.map((h) => ` #${h}`).join("").length : 0);

  return (
    <div className="max-w-[500px] rounded-2xl border border-[#2f3336] bg-black p-4 font-sans text-white">
      <div className="flex items-center gap-2">
        <div className="h-10 w-10 rounded-full bg-[#1d9bf0]" />
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-bold">Flow</span>
          <span className="text-xs text-[#71767b]">@flow</span>
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-[15px] leading-snug">
        {body}
        {hashtags.length > 0 && (
          <>
            {" "}
            {hashtags.map((h) => (
              <span key={h} className="text-[#1d9bf0]">
                #{h}{" "}
              </span>
            ))}
          </>
        )}
      </p>
      <div className="mt-3 flex items-center justify-between border-t border-[#2f3336] pt-2 text-xs text-[#71767b]">
        <span>💬</span>
        <span>🔁</span>
        <span>♡</span>
        <span>📊</span>
        <span className={charCount > 280 ? "text-[#f4212e]" : ""}>{charCount}/280</span>
      </div>
    </div>
  );
}
