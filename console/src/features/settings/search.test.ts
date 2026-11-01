import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DeploymentSettingView, SettingView, SettingsOverview } from '@shared/types';

import { searchSettings } from './search.ts';
import { DOMAIN_SECTIONS } from './sections.ts';

function setting(overrides: Partial<SettingView>): SettingView {
  return {
    scope: 'control-plane',
    key: 'max_runtime_replicas',
    section: 'materializations',
    label: 'Maximum workers',
    description: null,
    kind: 'integer',
    unit: null,
    minimum: 1,
    maximum: 1024,
    options: null,
    maxLength: null,
    nullable: false,
    advanced: false,
    danger: false,
    effect: null,
    envVar: 'CONTROL_PLANE_MAX_RUNTIME_REPLICAS',
    value: 64,
    source: 'default',
    defaultValue: 64,
    deploymentValue: null,
    deploymentSet: false,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  };
}

function overview(settings: SettingView[], deployment: DeploymentSettingView[] = []): SettingsOverview {
  const scope = (name: 'control-plane' | 'runtime') => ({
    scope: name,
    revision: 1,
    updatedAt: null,
    updatedBy: null,
    settings: settings.filter((item) => item.scope === name),
  });
  return {
    generatedAt: '2026-11-01T10:00:00Z',
    controlPlane: { reachable: true, error: null },
    scopes: { 'control-plane': scope('control-plane'), runtime: scope('runtime'), console: null },
    deployment,
    rollout: null,
    historyRetained: 100,
  };
}

const SETTINGS = [
  setting({}),
  setting({
    key: 'audit_retention_days',
    section: 'security',
    label: 'Audit log kept for',
    description: 'How long sign-ins and changes to users stay in the audit log.',
    envVar: 'CONTROL_PLANE_AUDIT_RETENTION_DAYS',
  }),
  setting({
    key: 'deleted_record_retention_days',
    section: 'deletion',
    label: 'Keep deleted records for',
    description: 'How long a deleted materialization’s records are kept for retention.',
    envVar: null,
  }),
  setting({
    key: 'snapshot_retention_hours',
    section: 'maintenance',
    label: 'Snapshot retention',
    description: 'Snapshots older than this expire.',
    envVar: null,
    advanced: true,
  }),
  setting({ scope: 'runtime', key: 'seal_interval_seconds', section: 'runtimes', label: 'Seal every', envVar: 'RUNTIME_SEAL_INTERVAL_SECONDS' }),
];

describe('searchSettings', () => {
  it('finds nothing without a query', () => {
    assert.deepEqual(searchSettings('  ', overview(SETTINGS), DOMAIN_SECTIONS), { groups: [], deployment: [], sections: [], count: 0 });
  });

  it('finds every setting holding each word, advanced ones too, by section in the navigation’s order', () => {
    const found = searchSettings('Retention', overview(SETTINGS), DOMAIN_SECTIONS);
    assert.deepEqual(
      found.groups.map((group) => [group.section.id, group.settings.map((item) => item.key)]),
      [
        ['security', ['audit_retention_days']],
        ['deletion', ['deleted_record_retention_days']],
        ['maintenance', ['snapshot_retention_hours']],
      ],
    );
    assert.equal(found.count, 3);
    assert.equal(searchSettings('audit kept', overview(SETTINGS), DOMAIN_SECTIONS).count, 1);
    assert.equal(searchSettings('audit seal', overview(SETTINGS), DOMAIN_SECTIONS).count, 0);
  });

  it('matches a key with its underscores read as spaces, and an environment variable', () => {
    assert.deepEqual(
      searchSettings('runtime replicas', overview(SETTINGS), DOMAIN_SECTIONS).groups.flatMap((group) => group.settings.map((item) => item.key)),
      ['max_runtime_replicas'],
    );
    assert.equal(searchSettings('RUNTIME_SEAL', overview(SETTINGS), DOMAIN_SECTIONS).groups[0]?.section.id, 'runtimes');
  });

  it('puts the settings a query names first, the rest of a section’s matches after them', () => {
    const described = setting({
      key: 'small_file_threshold',
      section: 'maintenance',
      label: 'Small file size',
      description: 'Files under this size are merged by compaction.',
      envVar: null,
    });
    const named = setting({ key: 'compaction_target', section: 'maintenance', label: 'Compaction target', envVar: null });
    const found = searchSettings('compaction', overview([...SETTINGS, described, named]), DOMAIN_SECTIONS);
    assert.deepEqual(found.groups[0]?.settings.map((item) => item.key), ['compaction_target', 'small_file_threshold']);
  });

  it('offers a section whose name matches as a way in, not every setting it holds', () => {
    const found = searchSettings('deletion', overview(SETTINGS), DOMAIN_SECTIONS);
    assert.deepEqual(found.sections.map((section) => section.id), ['deletion']);
    assert.equal(found.count, 0);
  });

  it('keeps to the sections a person may see', () => {
    const visible = DOMAIN_SECTIONS.filter((section) => section.id !== 'security');
    assert.equal(searchSettings('audit', overview(SETTINGS), visible).count, 0);
    assert.deepEqual(
      searchSettings('audit', overview(SETTINGS), visible).sections.map((section) => section.id),
      ['audit'],
    );
  });

  it('finds what only a deployment changes, while its section is shown', () => {
    const fixed: DeploymentSettingView = {
      component: 'control-plane',
      key: 'kafka_bootstrap_servers',
      label: 'Kafka brokers',
      description: null,
      envVar: 'KAFKA_BOOTSTRAP_SERVERS',
      value: 'kafka:9092',
    };
    const found = searchSettings('bootstrap', overview(SETTINGS, [fixed]), DOMAIN_SECTIONS);
    assert.deepEqual(found.deployment, [fixed]);
    assert.equal(found.count, 1);
    const hidden = DOMAIN_SECTIONS.filter((section) => section.kind !== 'deployment');
    assert.deepEqual(searchSettings('bootstrap', overview(SETTINGS, [fixed]), hidden).deployment, []);
  });

  it('names the sections without settings whose name or summary matches', () => {
    assert.deepEqual(searchSettings('bundle', overview(SETTINGS), DOMAIN_SECTIONS).sections.map((section) => section.id), ['groups']);
    assert.ok(searchSettings('roles', overview(SETTINGS), DOMAIN_SECTIONS).sections.some((section) => section.id === 'roles'));
  });
});
