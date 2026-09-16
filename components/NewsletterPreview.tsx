export function NewsletterPreview({ subject, body }: { subject: string; body: string }) {
  const wordCount = body.trim().split(/\s+/).filter(Boolean).length;

  return (
    <div className="max-w-[560px] rounded border border-[#d0d0d0] bg-white font-sans text-[#1a1a1a]">
      <div className="border-b border-[#e5e5e5] px-4 py-3">
        <div className="flex items-center justify-between text-xs text-[#767676]">
          <span>Inbox</span>
          <span className={wordCount < 250 || wordCount > 600 ? "text-[#c0392b]" : ""}>{wordCount} words</span>
        </div>
        <p className="mt-1 font-semibold">{subject}</p>
        <p className="text-xs text-[#767676]">from Flow</p>
      </div>
      <div className="whitespace-pre-wrap px-4 py-4 text-[14px] leading-relaxed">{body}</div>
    </div>
  );
}
