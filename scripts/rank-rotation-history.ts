import { readFileSync, writeFileSync } from 'node:fs';

interface DirectionReport {
  buyVenue: string;
  sellVenue: string;
  eligibleEpisodes: number;
  episodesPerDay: string;
  eligibleSamples: number;
  stressEligibleSamples: number;
  medianNetBps?: string;
  p90NetBps?: string;
  maxNetBps?: string;
  longestEligibleMs: number;
  medianEligibleEpisodeMs: number;
}

interface PairReport {
  base: string;
  quote: string;
  twoSidedEligible: boolean;
  directionFlips: number;
  overlappingDirectionEpisodes: number;
  directions: DirectionReport[];
}

interface HistoryReport {
  generatedAt: string;
  parameters?: Record<string, unknown>;
  candidateCount?: number;
  analyzedPairs?: number;
  ranking: PairReport[];
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function number(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

const input = arg('--input', 'data/history-all-1m-6d-2026-10-29.json');
const output = arg('--out', 'data/rotation-history-ranking.json');
const minEpisodesPerDirection = Number(arg('--min-episodes-per-direction', '1'));
const limit = Number(arg('--limit', '40'));
const report = JSON.parse(readFileSync(input, 'utf8')) as HistoryReport;
const rows = report.ranking
  .filter((pair) => pair.twoSidedEligible && pair.directions.length >= 2)
  .map((pair) => {
    const directions = [...pair.directions].sort(
      (left, right) => right.eligibleEpisodes - left.eligibleEpisodes,
    );
    const totalEpisodes = directions.reduce(
      (sum, direction) => sum + direction.eligibleEpisodes,
      0,
    );
    const totalPerDay = directions.reduce(
      (sum, direction) => sum + number(direction.episodesPerDay),
      0,
    );
    const stress = directions.reduce((sum, direction) => sum + direction.stressEligibleSamples, 0);
    const minDirectionEpisodes = Math.min(
      ...directions.map((direction) => direction.eligibleEpisodes),
    );
    return {
      pair: `${pair.base}/${pair.quote}`,
      base: pair.base,
      quote: pair.quote,
      totalEpisodes,
      totalPerDay,
      directionFlips: pair.directionFlips,
      stressSamples: stress,
      overlappingDirectionEpisodes: pair.overlappingDirectionEpisodes,
      minDirectionEpisodes,
      directions,
    };
  })
  .filter((row) => row.minDirectionEpisodes >= minEpisodesPerDirection)
  .sort(
    (left, right) =>
      right.totalEpisodes - left.totalEpisodes ||
      right.directionFlips - left.directionFlips ||
      right.stressSamples - left.stressSamples,
  );

console.log(
  'pair totalEpisodes episodesPerDay flips stress minDirection overlap | direction episodes/day stress medianBps p90Bps maxBps longestMin',
);
for (const row of rows.slice(0, limit)) {
  const directions = row.directions
    .map(
      (direction) =>
        `${direction.buyVenue}->${direction.sellVenue} ${direction.eligibleEpisodes}/${number(
          direction.episodesPerDay,
        ).toFixed(2)} ${direction.stressEligibleSamples} ${number(direction.medianNetBps).toFixed(
          2,
        )} ${number(direction.p90NetBps).toFixed(2)} ${number(direction.maxNetBps).toFixed(
          2,
        )} ${(direction.longestEligibleMs / 60_000).toFixed(1)}`,
    )
    .join(' | ');
  console.log(
    `${row.pair} ${row.totalEpisodes} ${row.totalPerDay.toFixed(2)} ${row.directionFlips} ${row.stressSamples} ${row.minDirectionEpisodes} ${row.overlappingDirectionEpisodes} | ${directions}`,
  );
}
writeFileSync(
  output,
  `${JSON.stringify(
    {
      source: input,
      generatedAt: report.generatedAt,
      parameters: report.parameters ?? {},
      candidateCount: report.candidateCount ?? null,
      analyzedPairs: report.analyzedPairs ?? null,
      ranking: rows,
    },
    null,
    2,
  )}\n`,
  'utf8',
);
console.log(`wrote ${output}`);
