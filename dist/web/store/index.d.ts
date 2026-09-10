/**
 * Trimmed 2026-09-10: the store once tracked chat, sync operations,
 * notifications, and mapping edits for pages that no longer exist. The one
 * piece of genuine UI state left is the non-embedded sidebar.
 */
interface AppState {
    sidebarOpen: boolean;
    toggleSidebar: () => void;
}
export declare const useAppStore: import("zustand").UseBoundStore<import("zustand").StoreApi<AppState>>;
export {};
