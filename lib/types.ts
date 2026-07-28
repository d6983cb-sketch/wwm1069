export type EventRecord = {
  id: string;
  title: string;
  submission_starts_at: string;
  submission_ends_at: string;
  voting_starts_at: string;
  voting_ends_at: string;
  submissions_locked: boolean;
  voting_locked: boolean;
  voting_override?: "auto" | "open" | "closed";
  leaderboard_mode: "hidden" | "live" | "final";
  status?: EventStatus | null;
  submission_identity_mode?: IdentityMode;
  voting_identity_mode?: IdentityMode;
  reveal_authors_after_results?: boolean;
};

export type EventStatus =
  | "draft"
  | "submission_open"
  | "submission_closed"
  | "voting_open"
  | "voting_closed"
  | "results_published"
  | "archived";

export type IdentityMode = "anonymous" | "named";

export type EntryRecord = {
  id: number;
  entry_code?: string | null;
  character_name: string;
  source_game: string;
  description: string | null;
  uses_ai_background: boolean;
  created_at: string;
  nickname: string;
  images: string[];
  vote_count: number;
};

export function eventPhase(event: EventRecord | null) {
  if (!event) return "尚未建立活動";
  if (event.status) {
    const labels: Record<EventStatus, string> = {
      draft: "草稿",
      submission_open: "投稿中",
      submission_closed: "投稿截止",
      voting_open: "投票中",
      voting_closed: "投票截止",
      results_published: "公布結果",
      archived: "活動封存",
    };
    return labels[event.status];
  }
  const now = Date.now();
  if (now < Date.parse(event.submission_starts_at)) return "尚未開始";
  if (isSubmissionOpen(event, now)) return "投稿中";
  if (now < Date.parse(event.voting_starts_at)) return "等待投票";
  if (isVotingOpen(event, now)) return "投票中";
  return event.leaderboard_mode === "final" ? "公布結果" : "活動結束";
}

export function isSubmissionOpen(event: EventRecord | null, now = Date.now()) {
  if (!event) return false;
  if (event.status) return event.status === "submission_open" && !event.submissions_locked;
  return !event.submissions_locked
    && now >= Date.parse(event.submission_starts_at)
    && now <= Date.parse(event.submission_ends_at);
}

export function isVotingOpen(event: EventRecord | null, now = Date.now()) {
  if (!event) return false;
  if (event.status) return event.status === "voting_open";
  if (event.voting_override === "open") return true;
  if (event.voting_override === "closed") return false;
  return !event.voting_locked
    && now >= Date.parse(event.voting_starts_at)
    && now <= Date.parse(event.voting_ends_at);
}

export function canShowAwards(event: EventRecord | null, now = Date.now()) {
  return Boolean(
    event
    && (
      event.status === "results_published"
      || (
        !event.status
        && event.leaderboard_mode === "final"
        && now > Date.parse(event.voting_ends_at)
      )
    )
  );
}

export function hasValidTimeline(event: Pick<
  EventRecord,
  "submission_starts_at" | "submission_ends_at" | "voting_starts_at" | "voting_ends_at"
>) {
  const times = [
    event.submission_starts_at,
    event.submission_ends_at,
    event.voting_starts_at,
    event.voting_ends_at,
  ].map(Date.parse);
  return times.every(Number.isFinite)
    && times[0] < times[1]
    && times[1] <= times[2]
    && times[2] < times[3];
}
