import { StatusBadge } from "./StatusBadge";

type Criterion = { score: number; notes: string };
type Criteria = Record<string, Criterion>;

export type EvaluationRow = {
  id: string;
  overall_status: "pass" | "revise" | "reject";
  criteria: Criteria;
  combined_score: number | null;
  unsupported_claims: Array<{ quote: string; reason: string }>;
  sections_needing_revision: Array<{ quote: string; reason: string }>;
  recommended_changes: string | null;
};

const CRITERION_LABELS: Record<string, string> = {
  topic_relevance: "Topic relevance",
  source_grounding: "Source grounding",
  factual_consistency: "Factual consistency",
  audience_fit: "Audience fit",
  tone: "Tone",
  seo_fit: "SEO fit",
  channel_fit: "Channel fit",
  clarity: "Clarity",
  completeness: "Completeness",
};

export function EvaluationPanel({ evaluation }: { evaluation: EvaluationRow }) {
  return (
    <div className="flex flex-col gap-3 rounded-[3px] border border-rule p-3 text-sm">
      <div className="flex items-center justify-between">
        <StatusBadge status={evaluation.overall_status} />
        {evaluation.combined_score != null && (
          <span className="text-xs text-muted">avg {evaluation.combined_score.toFixed(1)} / 5</span>
        )}
      </div>

      <ul className="flex flex-col gap-1.5">
        {Object.entries(evaluation.criteria).map(([key, c]) => (
          <li key={key} className="flex items-center gap-2">
            <span className="w-32 shrink-0 text-xs text-muted">{CRITERION_LABELS[key] ?? key}</span>
            <div className="h-1.5 flex-1 rounded-full bg-rule">
              <div
                className="h-1.5 rounded-full bg-approve"
                style={{ width: `${(c.score / 5) * 100}%` }}
              />
            </div>
            <span className="w-6 text-right text-xs text-muted">{c.score}</span>
          </li>
        ))}
      </ul>

      {evaluation.unsupported_claims.length > 0 && (
        <div>
          <p className="text-xs font-medium text-flag">Unsupported claims</p>
          <ul className="mt-1 flex flex-col gap-1 text-xs text-muted">
            {evaluation.unsupported_claims.map((c, i) => (
              <li key={i}>
                &ldquo;{c.quote}&rdquo;, {c.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {evaluation.recommended_changes && (
        <div>
          <p className="text-xs font-medium text-muted">Recommended changes</p>
          <p className="mt-1 text-xs">{evaluation.recommended_changes}</p>
        </div>
      )}
    </div>
  );
}
