import { vi } from "vitest";

export function createMockUIStoreState(overrides: Record<string, unknown> = {}) {
  return {
    isOnline: true,
    setPendingOpsCount: vi.fn(),
    ...overrides,
  };
}

export function createMockThreadStoreState(
  overrides: Record<string, unknown> = {},
) {
  return {
    threads: [],
    updateThread: vi.fn(),
    removeThread: vi.fn(),
    removeThreads: vi.fn(),
    // Removal actions bracket themselves with these so a sync-triggered reload
    // cannot re-show a thread while its server call is still in flight.
    beginRemoval: vi.fn(),
    endRemoval: vi.fn(),
    ...overrides,
  };
}

export function createMockAccountStoreState(
  overrides: Record<string, unknown> = {},
) {
  return {
    accounts: [],
    activeAccountId: null,
    ...overrides,
  };
}
