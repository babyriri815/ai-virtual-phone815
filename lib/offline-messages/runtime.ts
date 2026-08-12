"use client";

import { ReiClient } from "@rei-standard/amsg-client";
import { determineBaseUrl, isNativeAnthropicApi, isNativeGoogleApi } from "@/lib/api-helpers";
import { loadCharacters } from "@/lib/character-storage";
import { previewPromptPayload } from "@/lib/chat-engine";
import {
    clearFollowUpSchedule,
    loadChatMessages,
    loadChatSessions,
    loadFollowUpSchedule,
} from "@/lib/chat-storage";
import { parseAndSaveResponse } from "@/lib/follow-up-service";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "@/lib/settings-storage";
import { loadOfflineMessagesConfig, setOfflineMessagesEnabled, type OfflineMessagesConfig } from "./config";

const INBOX_DB = "float-cloud-message-inbox-v1";
const INBOX_STORE = "messages";
const TASKS_KEY = "float_cloud_followup_tasks_v1";
const PROCESSED_KEY = "float_cloud_processed_messages_v1";

type InboxRecord = { messageId: string; payload: CloudContentPush; receivedAt: number };
type CloudContentPush = {
    messageId?: string;
    id?: string;
    messageKind?: string;
    message?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
};

let stopRuntime: (() => void) | null = null;
let draining = false;

function createClient(config: OfflineMessagesConfig): ReiClient {
    return new ReiClient({
        baseUrl: config.workerUrl,
        userId: config.userId,
        serverToken: config.serverToken,
    });
}

function loadTaskMap(): Record<string, string> {
    try { return JSON.parse(localStorage.getItem(TASKS_KEY) || "{}"); } catch { return {}; }
}

function saveTaskMap(map: Record<string, string>): void {
    localStorage.setItem(TASKS_KEY, JSON.stringify(map));
}

function loadProcessed(): string[] {
    try { return JSON.parse(localStorage.getItem(PROCESSED_KEY) || "[]"); } catch { return []; }
}

function markProcessed(messageId: string): void {
    const next = [...loadProcessed().filter((id) => id !== messageId), messageId].slice(-500);
    localStorage.setItem(PROCESSED_KEY, JSON.stringify(next));
}

function openInbox(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(INBOX_DB, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(INBOX_STORE)) {
                request.result.createObjectStore(INBOX_STORE, { keyPath: "messageId" });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("无法打开离线消息库"));
    });
}

async function readInbox(): Promise<InboxRecord[]> {
    const db = await openInbox();
    try {
        return await new Promise((resolve, reject) => {
            const request = db.transaction(INBOX_STORE, "readonly").objectStore(INBOX_STORE).getAll();
            request.onsuccess = () => resolve((request.result || []) as InboxRecord[]);
            request.onerror = () => reject(request.error);
        });
    } finally {
        db.close();
    }
}

async function deleteInbox(messageIds: string[]): Promise<void> {
    if (!messageIds.length) return;
    const db = await openInbox();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(INBOX_STORE, "readwrite");
        for (const id of messageIds) tx.objectStore(INBOX_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
    db.close();
}

async function applyCloudPush(push: CloudContentPush): Promise<string | null> {
    if (push.messageKind !== "content" || !push.message?.trim()) return null;
    const messageId = String(push.messageId || push.id || "").trim();
    if (!messageId || loadProcessed().includes(messageId)) return messageId || null;
    const sessionId = String(push.metadata?.floatSessionId || "").trim();
    const session = loadChatSessions().find((item) => item.id === sessionId);
    if (!session) throw new Error(`找不到离线消息所属的聊天室：${sessionId}`);
    const followUpIndex = Number(push.metadata?.floatFollowUpIndex) || 1;
    await parseAndSaveResponse(
        push.message,
        sessionId,
        Math.max(0, followUpIndex - 1),
        followUpIndex,
        loadChatMessages(sessionId),
    );
    markProcessed(messageId);
    window.dispatchEvent(new CustomEvent("followup-fired", { detail: { sessionId } }));
    return messageId;
}

export async function drainOfflineMessages(): Promise<void> {
    if (draining) return;
    const config = loadOfflineMessagesConfig();
    if (!config?.enabled) return;
    draining = true;
    try {
        const client = createClient(config);
        await client.init();
        const fromInbox = await readInbox();
        const outbox = await client.getOutbox({ limit: 100 }).catch(() => ({ entries: [] }));
        const combined = new Map<string, CloudContentPush>();
        for (const record of fromInbox) combined.set(record.messageId, record.payload);
        for (const entry of outbox?.entries || []) {
            const push = entry?.push as CloudContentPush | undefined;
            const id = String(push?.messageId || entry?.messageId || "");
            if (push && id) combined.set(id, push);
        }
        const completed: string[] = [];
        for (const [id, push] of combined) {
            const applied = await applyCloudPush(push);
            if (applied) completed.push(id);
        }
        await deleteInbox(completed);
        if (completed.length) await client.ackOutbox(completed);
    } finally {
        draining = false;
    }
}

export async function enableOfflineMessagePush(config: OfflineMessagesConfig): Promise<void> {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") {
        throw new Error("这个浏览器不支持 Web Push。iPhone 请先把 Float 加到主画面后再开启。 ");
    }
    const permission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
    if (permission !== "granted") throw new Error("通知权限未允许，无法接收离线主动消息。 ");
    const registration = await navigator.serviceWorker.ready;
    const client = createClient(config);
    await client.init();
    const vapidPublicKey = await client.getVapidPublicKey();
    const subscription = await client.subscribePush(vapidPublicKey, registration);
    await client.putPushSubscription(subscription);
}

export function startOfflineMessagesRuntime(): () => void {
    if (stopRuntime) return stopRuntime;
    const handleMessage = (event: MessageEvent) => {
        if (event.data?.type === "REI_AMSG_PUSH") void drainOfflineMessages();
    };
    const handleOnline = () => void drainOfflineMessages();
    const handleVisibility = () => {
        if (document.visibilityState === "visible") void drainOfflineMessages();
    };
    navigator.serviceWorker?.addEventListener("message", handleMessage);
    window.addEventListener("online", handleOnline);
    document.addEventListener("visibilitychange", handleVisibility);
    void drainOfflineMessages();
    stopRuntime = () => {
        navigator.serviceWorker?.removeEventListener("message", handleMessage);
        window.removeEventListener("online", handleOnline);
        document.removeEventListener("visibilitychange", handleVisibility);
        stopRuntime = null;
    };
    return stopRuntime;
}

export async function scheduleCloudFollowUp(sessionId: string): Promise<boolean> {
    const config = loadOfflineMessagesConfig();
    if (!config?.enabled || !navigator.onLine) return false;
    const schedule = loadFollowUpSchedule(sessionId);
    const session = loadChatSessions().find((item) => item.id === sessionId);
    if (!schedule || !session || session.isGroup) return false;
    const character = loadCharacters().find((item) => item.id === session.contactId);
    if (!character) return false;

    const slot = resolveBinding(loadBindingConfig(), character.id, "chat");
    const apiConfig = loadApiConfigs().find((item) => item.id === slot.apiConfigId);
    if (!apiConfig?.apiKey) throw new Error(`${character.name} 没有可用的聊天 API Key。`);
    if (isNativeGoogleApi(apiConfig) || isNativeAnthropicApi(apiConfig)) {
        throw new Error("离线主动消息目前需要 OpenAI 相容格式；Google/Anthropic 原生格式请改用相容中转。 ");
    }
    const apiUrl = determineBaseUrl(apiConfig);
    if (!apiUrl) throw new Error("离线主动消息找不到 API Base URL。 ");

    const preview = await previewPromptPayload(session, loadChatMessages(sessionId), {
        followUpAuto: true,
        appId: "chat",
        appTags: ["chat", "text", "followup"],
        toolsAllowed: false,
    });
    const client = createClient(config);
    await client.init();
    const credId = `char:${character.id}/chat`;
    await client.putLlmCredentials([{
        credId,
        value: { apiUrl, apiKey: apiConfig.apiKey, primaryModel: preview.model },
    }]);

    const previous = loadTaskMap()[sessionId];
    if (previous) await client.cancelMessage(previous).catch(() => undefined);
    const response = await client.scheduleMessage({
        contactName: session.alias?.trim() || character.name,
        avatarUrl: character.avatar?.startsWith("http") ? character.avatar : undefined,
        messageType: "auto",
        messageSubtype: "chat",
        userMessage: "对方暂时没有继续回复，请依照角色个性决定是否主动再说一句。",
        firstSendTime: new Date(schedule.fireAt).toISOString(),
        recurrenceType: "none",
        credRefs: { chat: credId },
        messages: preview.messages,
        splitPattern: "(?!)",
        metadata: {
            floatSessionId: sessionId,
            floatCharacterId: character.id,
            floatFollowUpIndex: schedule.count + 1,
        },
    });
    const uuid = response?.data?.uuid;
    if (!uuid) throw new Error("云端没有返回排程编号。 ");
    const tasks = loadTaskMap();
    tasks[sessionId] = uuid;
    saveTaskMap(tasks);
    clearFollowUpSchedule(sessionId);
    return true;
}

export async function cancelCloudFollowUp(sessionId: string): Promise<void> {
    const config = loadOfflineMessagesConfig();
    const tasks = loadTaskMap();
    const uuid = tasks[sessionId];
    if (!config || !uuid) return;
    delete tasks[sessionId];
    saveTaskMap(tasks);
    const client = createClient(config);
    await client.init();
    await client.cancelMessage(uuid).catch(() => undefined);
}

export async function pauseOfflineMessages(): Promise<void> {
    const config = loadOfflineMessagesConfig();
    if (!config) return;
    const tasks = loadTaskMap();
    const entries = Object.entries(tasks);
    if (entries.length) {
        const client = createClient(config);
        await client.init();
        const results = await Promise.allSettled(entries.map(([, uuid]) => client.cancelMessage(uuid)));
        const failed: Record<string, string> = {};
        results.forEach((result, index) => {
            if (result.status === "rejected") failed[entries[index][0]] = entries[index][1];
        });
        saveTaskMap(failed);
        if (Object.keys(failed).length) throw new Error("部分云端排程取消失败，请保持联网后再试一次。 ");
    }
    setOfflineMessagesEnabled(false);
}
