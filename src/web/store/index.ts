import { create } from 'zustand';

/**
 * Trimmed 2026-09-10: the store once tracked chat, sync operations,
 * notifications, and mapping edits for pages that no longer exist. The one
 * piece of genuine UI state left is the non-embedded sidebar.
 */
interface AppState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
}));
