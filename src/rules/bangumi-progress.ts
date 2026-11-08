/**
 * Pure planning for Douban → Bangumi progress.
 * 豆瓣 → Bangumi 进度的纯规划逻辑。
 *
 * The collection status (`type=2`) is not the episode grid: a subject can be marked
 * "watched" while half its episodes are still unticked. Every decision here therefore
 * compares per-episode `type=2`, never `ep_status`.
 * 条目状态（type=2）不等于分集格子：条目可以标记“看过”，但仍有半集没点。这里始终用分集
 * `type=2` 判断，绝不用 `ep_status`。
 */
import type {
  BangumiCollection,
  BangumiEpisode,
  BangumiEpisodeState,
  BangumiSubject,
} from '../clients/bangumi';

export type EpisodeProgressPlan = {
  target: number[];
  missing: number[];
  existing: Map<number, BangumiEpisodeState>;
  reason?: 'no-episodes' | 'not-collected';
};

export function planEpisodeProgress(
  episodes: BangumiEpisode[],
  states: Map<number, BangumiEpisodeState>,
  options: {
    isMovie: boolean;
    includeSp: boolean;
    includeOpEd?: boolean;
    collected: boolean;
  },
): EpisodeProgressPlan {
  if (!options.collected) {
    return { target: [], missing: [], existing: states, reason: 'not-collected' };
  }

  const main = episodes
    .filter((episode) => episode.type === 0)
    .sort((a, b) => a.sort - b.sort || a.id - b.id);
  const sp = options.includeSp
    ? episodes
        .filter((episode) => episode.type === 1)
        .sort((a, b) => a.sort - b.sort || a.id - b.id)
    : [];
  const themes = options.includeOpEd
    ? episodes
        .filter((episode) => episode.type === 2 || episode.type === 3)
        .sort((a, b) => a.sort - b.sort || a.id - b.id)
    : [];
  const targetEpisodes = options.isMovie
    ? main.slice(0, 1)
    : [...main, ...sp, ...themes];
  const target = targetEpisodes.map((episode) => episode.id);
  const missing = target.filter((id) => states.get(id)?.type !== 2);

  return {
    target,
    missing,
    existing: states,
    reason: target.length === 0 ? 'no-episodes' : undefined,
  };
}

export type BookProgressPlan = {
  epStatus?: number;
  volStatus?: number;
  skip: boolean;
  reason?: 'both-unknown' | 'no-totals' | 'nothing-to-write';
};

export function planBookProgress(
  existing: BangumiCollection,
  subject: BangumiSubject,
): BookProgressPlan {
  const chapterKnown = (existing.ep_status ?? 0) > 0;
  const volumeKnown = (existing.vol_status ?? 0) > 0;
  if (!chapterKnown && !volumeKnown) {
    return { skip: true, reason: 'both-unknown' };
  }

  const epStatus = chapterKnown && (subject.eps ?? 0) > 0 ? subject.eps : undefined;
  const volStatus =
    volumeKnown && (subject.volumes ?? 0) > 0 ? subject.volumes : undefined;

  if (epStatus == null && volStatus == null) {
    return { skip: true, reason: 'no-totals' };
  }

  const epDone = epStatus == null || (existing.ep_status ?? 0) >= epStatus;
  const volDone = volStatus == null || (existing.vol_status ?? 0) >= volStatus;
  if (epDone && volDone) {
    return { skip: true, reason: 'nothing-to-write' };
  }

  return { epStatus, volStatus, skip: false };
}
