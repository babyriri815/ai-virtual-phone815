export type OfflineMessagesConfig = {
    enabled: boolean;
    workerUrl: string;
    serverToken: string;
    userId: string;
    accountId: string;
    scriptName: string;
    databaseId: string;
    deployedAt: number;
};

const CONFIG_KEY = "float_offline_messages_config_v1";
export const OFFLINE_MESSAGES_CONFIG_EVENT = "float-offline-messages-config-updated";

export function loadOfflineMessagesConfig(): OfflineMessagesConfig | null {
    if (typeof window === "undefined") return null;
    try {
        const parsed = JSON.parse(localStorage.getItem(CONFIG_KEY) || "null") as Partial<OfflineMessagesConfig> | null;
        if (!parsed?.workerUrl || !parsed.serverToken || !parsed.userId) return null;
        return {
            enabled: parsed.enabled === true,
            workerUrl: parsed.workerUrl.replace(/\/+$/, ""),
            serverToken: parsed.serverToken,
            userId: parsed.userId,
            accountId: parsed.accountId || "",
            scriptName: parsed.scriptName || "",
            databaseId: parsed.databaseId || "",
            deployedAt: Number(parsed.deployedAt) || Date.now(),
        };
    } catch {
        return null;
    }
}

export function saveOfflineMessagesConfig(config: OfflineMessagesConfig): void {
    if (typeof window === "undefined") return;
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    window.dispatchEvent(new CustomEvent(OFFLINE_MESSAGES_CONFIG_EVENT, { detail: config }));
}

export function setOfflineMessagesEnabled(enabled: boolean): OfflineMessagesConfig | null {
    const config = loadOfflineMessagesConfig();
    if (!config) return null;
    const next = { ...config, enabled };
    saveOfflineMessagesConfig(next);
    return next;
}

export function clearOfflineMessagesConfig(): void {
    if (typeof window === "undefined") return;
    localStorage.removeItem(CONFIG_KEY);
    window.dispatchEvent(new CustomEvent(OFFLINE_MESSAGES_CONFIG_EVENT, { detail: null }));
}
