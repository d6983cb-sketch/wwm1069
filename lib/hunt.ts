export type HuntEventStatus = "draft" | "open" | "closed" | "results_published" | "archived";
export type HuntLeaderboardMode = "hidden" | "live" | "final";
export type HuntReviewStatus = "pending" | "correct" | "incorrect" | "duplicate";

export type HuntEventRecord = {
  id: string;
  title: string;
  description: string | null;
  target_image_path: string;
  show_target_image: boolean;
  total_targets: number;
  starts_at: string;
  ends_at: string;
  status: HuntEventStatus;
  leaderboard_mode: HuntLeaderboardMode;
};

export type HuntSubmissionRecord = {
  id: number;
  hunt_event_id: string;
  profile_id: string;
  image_path: string;
  file_hash: string;
  player_note: string | null;
  status: HuntReviewStatus;
  matched_target_number: number | null;
  duplicate_of_id: number | null;
  review_note: string | null;
  submitted_at: string;
  reviewed_at: string | null;
};

export type HuntRankingRow = {
  profileId: string;
  nickname: string;
  correctCount: number;
  reachedAt: string | null;
  rank: number;
};

export function isHuntOpen(event: HuntEventRecord | null, now = Date.now()) {
  if (!event || event.status !== "open") return false;
  return now >= Date.parse(event.starts_at) && now <= Date.parse(event.ends_at);
}

export function canShowHuntRanking(event: HuntEventRecord | null) {
  if (!event) return false;
  if (event.status === "results_published" || event.status === "archived") return true;
  return event.leaderboard_mode === "live" && event.status === "open";
}

export function calculateHuntRanking(
  submissions: Array<Pick<HuntSubmissionRecord, "profile_id" | "status" | "submitted_at">>,
  profiles: Array<{ id: string; nickname: string }>,
) {
  const correct = submissions.filter((submission) => submission.status === "correct");
  const rows: Omit<HuntRankingRow, "rank">[] = profiles.map((profile) => {
    const finds = correct
      .filter((submission) => submission.profile_id === profile.id)
      .sort((left, right) => Date.parse(left.submitted_at) - Date.parse(right.submitted_at));
    return {
      profileId: profile.id,
      nickname: profile.nickname,
      correctCount: finds.length,
      reachedAt: finds.at(-1)?.submitted_at ?? null,
    };
  }).filter((row) => row.correctCount > 0)
    .sort((left, right) => (
      right.correctCount - left.correctCount
      || Date.parse(left.reachedAt ?? "9999-12-31") - Date.parse(right.reachedAt ?? "9999-12-31")
      || left.nickname.localeCompare(right.nickname, "zh-Hant")
    ));

  return rows.map((row, index): HuntRankingRow => ({ ...row, rank: index + 1 }));
}
