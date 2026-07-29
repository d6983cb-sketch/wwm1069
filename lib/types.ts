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
  allow_admin_crop_after_submission?: boolean;
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
  images: SubmissionImageRecord[];
  vote_count: number;
};

export const SUBMISSION_IMAGE_ASPECT_RATIO = 4 / 5;
export const SUBMISSION_IMAGE_ASPECT_VALUE = "4/5";

export type SubmissionImageCrop = {
  crop_x: number;
  crop_y: number;
  zoom: number;
  rotation: number;
  aspect_ratio: string;
};

export type SubmissionImageRecord = SubmissionImageCrop & {
  id: number;
  storage_path: string;
  position: number;
};

export const DEFAULT_SUBMISSION_IMAGE_CROP: SubmissionImageCrop = {
  crop_x: 0,
  crop_y: 0,
  zoom: 1,
  rotation: 0,
  aspect_ratio: SUBMISSION_IMAGE_ASPECT_VALUE,
};

export function normalizeSubmissionImage<T extends Partial<SubmissionImageRecord> & { storage_path: string }>(
  image: T,
): T & SubmissionImageCrop {
  const clamp = (value: unknown, minimum: number, maximum: number, fallback: number) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
  };
  return {
    ...image,
    crop_x: clamp(image.crop_x, -50, 50, 0),
    crop_y: clamp(image.crop_y, -50, 50, 0),
    zoom: clamp(image.zoom, 1, 3, 1),
    rotation: clamp(image.rotation, -180, 180, 0),
    aspect_ratio: SUBMISSION_IMAGE_ASPECT_VALUE,
  };
}

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
  if (event.voting_locked || event.voting_override === "closed") return false;
  if (event.status) return event.status === "voting_open";
  if (event.voting_override === "open") return true;
  return now >= Date.parse(event.voting_starts_at)
    && now <= Date.parse(event.voting_ends_at);
}

export function canShowAwards(event: EventRecord | null, now = Date.now()) {
  return Boolean(
    event
    && (
      event.status === "results_published"
      || event.status === "archived"
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
