export const tieHandlingValues = [
  "joint",
  "admin_decision",
  "earliest_submission",
  "earliest_reached_votes",
  "unresolved",
] as const;

export type TieHandling = (typeof tieHandlingValues)[number];

export type RankableEntry = {
  id: number;
  created_at: string;
};

export type RankingVote = {
  entry_id: number;
  created_at: string;
};

export type AwardRanking = {
  entryId: number;
  rank: number;
  votes: number;
  reachedAt: string | null;
  hasEqualVotes: boolean;
};

export function isTieHandling(value: unknown): value is TieHandling {
  return tieHandlingValues.includes(String(value) as TieHandling);
}

function timestamp(value: string | null) {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

export function calculateAwardRanking(
  entries: RankableEntry[],
  votes: RankingVote[],
  tieHandling: TieHandling,
): AwardRanking[] {
  const voteTimes = new Map<number, string[]>();
  for (const vote of votes) {
    const current = voteTimes.get(vote.entry_id) ?? [];
    current.push(vote.created_at);
    voteTimes.set(vote.entry_id, current);
  }

  const rows = entries.map((entry) => {
    const times = voteTimes.get(entry.id) ?? [];
    const reachedAt = times.length
      ? times.reduce((latest, current) => (
        timestamp(current) > timestamp(latest) ? current : latest
      ))
      : null;
    return {
      entry,
      votes: times.length,
      reachedAt,
    };
  });

  rows.sort((a, b) => {
    const voteDifference = b.votes - a.votes;
    if (voteDifference) return voteDifference;
    if (tieHandling === "earliest_reached_votes") {
      const reachedDifference = timestamp(a.reachedAt) - timestamp(b.reachedAt);
      if (reachedDifference) return reachedDifference;
    }
    if (tieHandling === "earliest_submission" || tieHandling === "earliest_reached_votes") {
      const submissionDifference = timestamp(a.entry.created_at) - timestamp(b.entry.created_at);
      if (submissionDifference) return submissionDifference;
    }
    return a.entry.id - b.entry.id;
  });

  const decisiveTieBreak = tieHandling === "earliest_submission"
    || tieHandling === "earliest_reached_votes";
  let previousVotes: number | null = null;
  let currentRank = 0;

  return rows.map((row, index) => {
    if (decisiveTieBreak || previousVotes !== row.votes) currentRank = index + 1;
    previousVotes = row.votes;
    return {
      entryId: row.entry.id,
      rank: currentRank,
      votes: row.votes,
      reachedAt: row.reachedAt,
      hasEqualVotes: rows.some((other) => (
        other.entry.id !== row.entry.id && other.votes === row.votes
      )),
    };
  });
}
