import { types } from 'node:util';

// Policy ceilings, not measured memory limits. Inputs must be own data fields.
export const RAW_HOST_BUDGET_CEILINGS = Object.freeze({ maxBytes: 8 * 1024 * 1024, maxEvents: 10000 });

function dataField(object, key) {
  if (object === null || typeof object !== 'object' || types.isProxy(object)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

const count = value => Number.isSafeInteger(value) && value >= 0;

// This decision neither opens a backend nor asserts freshness, EOF, or bounded memory.
export function preflightRawHostBudget(metadata, budget) {
  const maxBytes = dataField(budget, 'maxBytes');
  const maxEvents = dataField(budget, 'maxEvents');
  if (!count(maxBytes) || !count(maxEvents) || maxBytes > RAW_HOST_BUDGET_CEILINGS.maxBytes || maxEvents > RAW_HOST_BUDGET_CEILINGS.maxEvents) {
    return { allowed: false, reason: 'invalid-budget' };
  }
  const sizeBytes = dataField(metadata, 'sizeBytes');
  const eventCount = dataField(metadata, 'eventCount');
  if (!count(sizeBytes) || !count(eventCount)) return { allowed: false, reason: 'unknown-metadata' };
  if (sizeBytes > maxBytes || eventCount > maxEvents) return { allowed: false, reason: 'budget-exceeded' };
  return { allowed: true, reason: 'within-budget' };
}
