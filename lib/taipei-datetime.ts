const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const LOCAL_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function toTaipeiInput(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return new Date(date.getTime() + TAIPEI_OFFSET_MS)
    .toISOString()
    .slice(0, 16);
}

export function taipeiInputToIso(value: string) {
  if (!LOCAL_DATETIME_PATTERN.test(value)) return "";

  const date = new Date(`${value}:00+08:00`);
  if (Number.isNaN(date.getTime())) return "";

  return date.toISOString();
}
