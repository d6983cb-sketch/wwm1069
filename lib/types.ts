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
};

export type EntryRecord = {
  id: number;
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
  const now = Date.now();
  if (event.voting_override === "open") return "投票中";
  if (now < Date.parse(event.submission_starts_at)) return "尚未開始";
  if (now <= Date.parse(event.submission_ends_at) && !event.submissions_locked) return "投稿中";
  if (now < Date.parse(event.voting_starts_at)) return "等待投票";
  if (isVotingOpen(event, now)) return "投票中";
  return event.leaderboard_mode === "final" ? "公布結果" : "活動結束";
}

export function isVotingOpen(event: EventRecord | null, now = Date.now()) {
  if (!event) return false;
  if (event.voting_override === "open") return true;
  if (event.voting_override === "closed") return false;
  return !event.voting_locked
    && now >= Date.parse(event.voting_starts_at)
    && now <= Date.parse(event.voting_ends_at);
}
