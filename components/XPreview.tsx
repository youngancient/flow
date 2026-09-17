import { AvatarIcon } from "./AvatarIcon";
import { VerifiedBadge } from "./VerifiedBadge";
import { X_CHAR_LIMIT, xPostCharCount } from "@/lib/rules";

export function XPreview({ body, hashtags }: { body: string; hashtags: string[] }) {
  const charCount = xPostCharCount(body, hashtags);

  return (
    <div className="max-w-[500px] rounded-2xl border border-[#2f3336] bg-black p-4 font-sans text-white">
      <div className="flex items-center gap-2">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#1d9bf0]">
          <AvatarIcon className="h-6 w-6" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="flex items-center gap-1 text-sm font-bold">
            Flow
            <VerifiedBadge className="h-4 w-4" />
          </span>
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
        <span className={charCount > X_CHAR_LIMIT ? "text-[#f4212e]" : ""}>
          {charCount}/{X_CHAR_LIMIT}
        </span>
      </div>
    </div>
  );
}
