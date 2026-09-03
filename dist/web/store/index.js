import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
const createId = () => Math.random().toString(36).slice(2, 10);
export const useAppStore = create()(subscribeWithSelector((set, get) => ({
    sidebarOpen: true,
    chatOpen: false,
    chatMessages: [
        {
            id: 'welcome',
            role: 'assistant',
            content: 'Hi! I\'m your ProductPipeline assistant. I can help you sync products, check status, and manage orders.',
            timestamp: new Date(),
        },
    ],
    chatLoading: false,
    activeSyncOperations: [],
    syncStatus: 'idle',
    lastSyncTime: null,
    connections: {
        shopify: false,
        ebay: false,
    },
    notifications: [],
    unsavedMappingChanges: new Map(),
    savingMappings: false,
    toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
    toggleChat: () => set((state) => ({ chatOpen: !state.chatOpen })),
    setChatLoading: (loading) => set({ chatLoading: loading }),
    addChatMessage: (message) => set((state) => ({
        chatMessages: [
            ...state.chatMessages,
            {
                ...message,
                id: `${Date.now()}-${createId()}`,
            },
        ],
    })),
    clearChatHistory: () => set({
        chatMessages: [
            {
                id: 'welcome',
                role: 'assistant',
                content: 'Chat cleared. How can I help?',
                timestamp: new Date(),
            },
        ],
    }),
    addSyncOperation: (operation) => set((state) => ({
        activeSyncOperations: Array.from(new Set([...state.activeSyncOperations, operation])),
        syncStatus: 'syncing',
    })),
    removeSyncOperation: (operation) => set((state) => {
        const active = state.activeSyncOperations.filter((op) => op !== operation);
        return {
            activeSyncOperations: active,
            syncStatus: active.length > 0 ? 'syncing' : 'idle',
            lastSyncTime: active.length > 0 ? state.lastSyncTime : new Date(),
        };
    }),
    setSyncStatus: (status) => set({
        syncStatus: status,
        lastSyncTime: status === 'idle' ? new Date() : get().lastSyncTime,
    }),
    setConnectionStatus: (platform, connected) => set((state) => ({
        connections: {
            ...state.connections,
            [platform]: connected,
        },
    })),
    addNotification: (notification) => {
        const id = createId();
        const entry = {
            ...notification,
            id,
            timestamp: new Date(),
        };
        set((state) => ({
            notifications: [entry, ...state.notifications],
        }));
        if (notification.autoClose) {
            setTimeout(() => {
                get().removeNotification(id);
            }, notification.autoClose);
        }
    },
    removeNotification: (id) => set((state) => ({
        notifications: state.notifications.filter((notice) => notice.id !== id),
    })),
    clearNotifications: () => set({ notifications: [] }),
    setUnsavedMappingChange: (key, value) => set((state) => {
        const next = new Map(state.unsavedMappingChanges);
        next.set(key, { ...(next.get(key) || {}), ...value });
        return { unsavedMappingChanges: next };
    }),
    removeUnsavedMappingChange: (key) => set((state) => {
        const next = new Map(state.unsavedMappingChanges);
        next.delete(key);
        return { unsavedMappingChanges: next };
    }),
    clearUnsavedMappingChanges: () => set({ unsavedMappingChanges: new Map() }),
    setSavingMappings: (saving) => set({ savingMappings: saving }),
})));
