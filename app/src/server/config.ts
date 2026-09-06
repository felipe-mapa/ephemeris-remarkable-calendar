import fs from 'node:fs';
import YAML from 'yaml';
import { paths } from './paths.js';

export interface CalendarSource {
  name: string;
  source: string;
  color: string;
}

export function loadCalendarSources(configPath: string = paths.config): CalendarSource[] {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = YAML.parse(raw) as { calendars?: Partial<CalendarSource>[] } | null;
  return (parsed?.calendars ?? [])
    .filter((c) => typeof c.source === 'string' && c.source.length > 0)
    .map((c) => ({
      name: c.name ?? 'Unknown',
      source: c.source as string,
      color: c.color ?? 'black',
    }));
}
