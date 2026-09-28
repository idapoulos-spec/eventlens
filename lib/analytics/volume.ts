/** Today's volume as a percentage of average volume, e.g. 84 means 84% of average. */
export function relativeVolume(volume: number | null, averageVolume: number | null): number | null {
  if (volume === null || averageVolume === null || averageVolume <= 0) return null;
  return (volume / averageVolume) * 100;
}
