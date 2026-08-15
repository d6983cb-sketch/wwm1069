export type HuntEventStatus = "draft" | "open" | "closed" | "results_published" | "archived";
export type HuntLeaderboardMode = "hidden" | "live" | "final";
export type HuntReviewStatus = "pending" | "correct" | "incorrect" | "duplicate";
export type HuntAutoStatus = "not_run" | "matched" | "uncertain" | "duplicate" | "error";

export type HuntAutoCandidate = {
  targetNumber: number;
  similarity: number;
};

export type HuntAutoVerification = {
  matchedTargetNumber: number;
  objectVisible: boolean;
  samePhysicalLocation: boolean;
  confidence: number;
  reason: string;
};

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
  auto_match_enabled: boolean;
  auto_match_threshold: number;
  auto_match_margin: number;
  photo_reveal_at: string | null;
  reveal_player_photos: boolean;
  reveal_answer_photos: boolean;
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
  auto_status: HuntAutoStatus;
  auto_match_target_number: number | null;
  auto_similarity: number | null;
  auto_candidates: HuntAutoCandidate[];
  auto_checked_at: string | null;
  auto_model: string | null;
  auto_verification: HuntAutoVerification | null;
  auto_verification_confidence: number | null;
  auto_verification_model: string | null;
};

export type HuntReferencePoint = {
  id: string;
  hunt_event_id: string;
  target_number: number;
  label: string | null;
  is_active: boolean;
  created_at: string;
  images: HuntReferenceImage[];
};

export type HuntReferenceImage = {
  id: string;
  reference_point_id: string;
  image_path: string;
  mime_type: "image/jpeg" | "image/png";
  embedding_model: string;
  is_active: boolean;
  created_at: string;
  signedUrl?: string | null;
};

export type HuntRankingRow = {
  profileId: string;
  nickname: string;
  correctCount: number;
  confirmedCount: number;
  aiPendingCount: number;
  reachedAt: string | null;
  rank: number;
};

export type HuntPublicPlayerPhoto = {
  id: number;
  targetNumber: number;
  nickname: string;
  submittedAt: string;
  signedUrl: string;
  verificationStatus: "confirmed" | "ai_pending";
};

export type HuntPublicAnswerPhoto = {
  id: string;
  targetNumber: number;
  label: string | null;
  signedUrl: string;
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

export function hasReachedHuntPhotoRevealTime(event: HuntEventRecord | null, now = Date.now()) {
  if (!event?.photo_reveal_at) return false;
  const revealAt = Date.parse(event.photo_reveal_at);
  return Number.isFinite(revealAt) && now >= revealAt;
}

export function canShowHuntPlayerPhotos(event: HuntEventRecord | null, now = Date.now()) {
  return event?.reveal_player_photos === true && hasReachedHuntPhotoRevealTime(event, now);
}

export function canShowHuntAnswerPhotos(event: HuntEventRecord | null, now = Date.now()) {
  return event?.reveal_answer_photos === true && hasReachedHuntPhotoRevealTime(event, now);
}

export function calculateHuntRanking(
  submissions: Array<Pick<HuntSubmissionRecord, "profile_id" | "status" | "submitted_at" | "matched_target_number" | "auto_status" | "auto_match_target_number">>,
  profiles: Array<{ id: string; nickname: string }>,
) {
  const rows: Omit<HuntRankingRow, "rank">[] = profiles.map((profile) => {
    const acceptedTargets = new Map<number, { submittedAt: string; confirmed: boolean }>();
    for (const submission of submissions) {
      if (submission.profile_id !== profile.id) continue;
      const confirmed = submission.status === "correct" && submission.matched_target_number != null;
      const aiPending = submission.status === "pending"
        && submission.auto_status === "matched"
        && submission.auto_match_target_number != null;
      const targetNumber = confirmed ? submission.matched_target_number : aiPending ? submission.auto_match_target_number : null;
      if (targetNumber == null) continue;
      const previous = acceptedTargets.get(targetNumber);
      if (!previous) {
        acceptedTargets.set(targetNumber, { submittedAt: submission.submitted_at, confirmed });
      } else {
        acceptedTargets.set(targetNumber, {
          submittedAt: Date.parse(submission.submitted_at) < Date.parse(previous.submittedAt)
            ? submission.submitted_at
            : previous.submittedAt,
          confirmed: previous.confirmed || confirmed,
        });
      }
    }
    const finds = [...acceptedTargets.values()]
      .sort((left, right) => Date.parse(left.submittedAt) - Date.parse(right.submittedAt));
    const confirmedCount = finds.filter((find) => find.confirmed).length;
    return {
      profileId: profile.id,
      nickname: profile.nickname,
      correctCount: finds.length,
      confirmedCount,
      aiPendingCount: finds.length - confirmedCount,
      reachedAt: finds.at(-1)?.submittedAt ?? null,
    };
  }).filter((row) => row.correctCount > 0)
    .sort((left, right) => (
      right.correctCount - left.correctCount
      || Date.parse(left.reachedAt ?? "9999-12-31") - Date.parse(right.reachedAt ?? "9999-12-31")
      || left.nickname.localeCompare(right.nickname, "zh-Hant")
    ));

  return rows.map((row, index): HuntRankingRow => ({ ...row, rank: index + 1 }));
}

export function calculateHuntProgress(
  submissions: Array<Pick<HuntSubmissionRecord, "status" | "matched_target_number" | "auto_status" | "auto_match_target_number">>,
) {
  const confirmed = new Set<number>();
  const provisional = new Set<number>();
  for (const submission of submissions) {
    if (submission.status === "correct" && submission.matched_target_number) {
      confirmed.add(submission.matched_target_number);
      provisional.add(submission.matched_target_number);
    }
  }
  for (const submission of submissions) {
    if (submission.status === "pending" && submission.auto_status === "matched" && submission.auto_match_target_number) {
      provisional.add(submission.auto_match_target_number);
    }
  }
  return { confirmedCount: confirmed.size, provisionalCount: provisional.size };
}
