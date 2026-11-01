/**
 * Search across a Settings page: every setting it holds, those only a deployment changes, and the
 * sections that hold no settings, such as Users or the audit log. Plain logic, no React.
 */

import type { DeploymentSettingView, SettingView, SettingsOverview } from '@shared/types';

import { SETTINGS_KINDS, type SettingsSection } from './sections.ts';
import { sectionSettings } from './values.ts';

export interface SettingsSearchResult {
  /** The settings that match, by the section that holds them, in the navigation's order. */
  groups: { section: SettingsSection; settings: SettingView[] }[];
  /** Settings only the deployment changes, read-only here. */
  deployment: DeploymentSettingView[];
  /** Sections whose name matches, and those without settings whose summary does: Users, the audit log. */
  sections: SettingsSection[];
  /** Every setting found, the deployment's included. */
  count: number;
}

/** A query's words; something matches when it holds every one of them. */
export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function matches(words: string[], ...parts: (string | null | undefined)[]): boolean {
  const text = parts
    .filter((part): part is string => Boolean(part))
    // `max_runtime_replicas` is found by "runtime replicas" too.
    .flatMap((part) => (part.includes('_') ? [part, part.replace(/_/g, ' ')] : [part]))
    .join('\n')
    .toLowerCase();
  return words.every((word) => text.includes(word));
}

/**
 * What a query finds among the sections a person may see. A setting matches on its own words: its
 * name, description, key or environment variable; one whose name holds every word comes first in
 * its section, the rest in catalog order. An advanced setting is found like any other. A section
 * whose name matches is offered whole, as a way in, rather than as every setting it holds.
 */
export function searchSettings(query: string, overview: SettingsOverview | undefined, sections: SettingsSection[]): SettingsSearchResult {
  const words = queryWords(query);
  const empty: SettingsSearchResult = { groups: [], deployment: [], sections: [], count: 0 };
  if (words.length === 0) return empty;

  const groups = sections
    .filter((section) => section.kind === 'settings')
    .map((section) => {
      const found = sectionSettings(overview, section.id).filter((setting) =>
        matches(words, setting.label, setting.description, setting.key, setting.envVar),
      );
      const named = found.filter((setting) => matches(words, setting.label));
      return { section, settings: [...named, ...found.filter((setting) => !named.includes(setting))] };
    })
    .filter((group) => group.settings.length > 0);

  const deployment = sections.some((section) => section.kind === 'deployment')
    ? (overview?.deployment ?? []).filter((entry) => matches(words, entry.label, entry.description, entry.key, entry.envVar))
    : [];

  return {
    groups,
    deployment,
    sections: sections.filter((section) =>
      // A section of settings is searched through its settings; its summary would only echo them.
      SETTINGS_KINDS.has(section.kind) ? matches(words, section.label) : matches(words, section.label, section.summary),
    ),
    count: groups.reduce((total, group) => total + group.settings.length, 0) + deployment.length,
  };
}
