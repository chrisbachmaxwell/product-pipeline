export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
    commandResult?: unknown;
    error?: string;
}
export interface NotificationState {
    id: string;
    type: 'info' | 'success' | 'warning' | 'error';
    title: string;
    message?: string;
    timestamp: Date;
    autoClose?: number;
}
interface AppStore {
    sidebarOpen: boolean;
    chatOpen: boolean;
    chatMessages: ChatMessage[];
    chatLoading: boolean;
    activeSyncOperations: string[];
    syncStatus: 'idle' | 'syncing' | 'error';
    lastSyncTime: Date | null;
    connections: {
        shopify: boolean;
        ebay: boolean;
    };
    notifications: NotificationState[];
    unsavedMappingChanges: Map<string, Record<string, unknown>>;
    savingMappings: boolean;
    toggleSidebar: () => void;
    toggleChat: () => void;
    setChatLoading: (loading: boolean) => void;
    addChatMessage: (message: Omit<ChatMessage, 'id'>) => void;
    clearChatHistory: () => void;
    addSyncOperation: (operation: string) => void;
    removeSyncOperation: (operation: string) => void;
    setSyncStatus: (status: 'idle' | 'syncing' | 'error') => void;
    setConnectionStatus: (platform: 'shopify' | 'ebay', connected: boolean) => void;
    addNotification: (notification: Omit<NotificationState, 'id' | 'timestamp'>) => void;
    removeNotification: (id: string) => void;
    clearNotifications: () => void;
    setUnsavedMappingChange: (key: string, value: Record<string, unknown>) => void;
    removeUnsavedMappingChange: (key: string) => void;
    clearUnsavedMappingChanges: () => void;
    setSavingMappings: (saving: boolean) => void;
}
export declare const useAppStore: import("zustand").UseBoundStore<Omit<import("zustand").StoreApi<AppStore>, "subscribe"> & {
    subscribe: {
        (listener: (selectedState: AppStore, previousSelectedState: AppStore) => void): () => void;
        <U>(selector: (state: AppStore) => U, listener: (selectedState: U, previousSelectedState: U) => void, options?: {
            equalityFn?: ((a: U, b: U) => boolean) | undefined;
            fireImmediately?: boolean;
        } | undefined): () => void;
    };
}>;
export {};
