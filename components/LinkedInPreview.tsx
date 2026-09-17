import { AvatarIcon } from "./AvatarIcon";

export function LinkedInPreview({ body }: { body: string }) {
  return (
    <div className="max-w-[552px] rounded-lg border border-[#d9d9d9] bg-white p-4 font-sans text-[#000000e6] shadow-sm">
      <div className="flex items-center gap-2">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#0a66c2]">
          <AvatarIcon className="h-7 w-7" />
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold">Flow</span>
          <span className="text-xs text-[#00000099]">Marketing Agency · 1st</span>
          <span className="text-xs text-[#00000099]">now</span>
        </div>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-normal">{body}</p>
      <div className="mt-3 flex gap-4 border-t border-[#d9d9d9] pt-2 text-xs font-medium text-[#00000099]">
        <span>👍 Like</span>
        <span>💬 Comment</span>
        <span>↗ Repost</span>
        <span>➤ Send</span>
      </div>
    </div>
  );
}
