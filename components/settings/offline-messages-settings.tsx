"use client";

import { useEffect, useMemo, useState } from "react";
import { BellRing, CheckCircle2, Cloud, Copy, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import {
    loadOfflineMessagesConfig,
    saveOfflineMessagesConfig,
    clearOfflineMessagesConfig,
    type OfflineMessagesConfig,
} from "@/lib/offline-messages/config";
import { enableOfflineMessagePush, pauseOfflineMessages, startOfflineMessagesRuntime } from "@/lib/offline-messages/runtime";

type Account = { id: string; name: string };
type DeployResult = {
    ok: true;
    workerUrl: string;
    serverToken: string;
    accountId: string;
    scriptName: string;
    databaseId: string;
};

async function readJson(response: Response) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
        throw new Error([payload.error, payload.hint].filter(Boolean).join("\n") || `请求失败 (${response.status})`);
    }
    return payload;
}

export function OfflineMessagesSettings({ onNotice }: { onNotice: (message: string) => void }) {
    const [config, setConfig] = useState<OfflineMessagesConfig | null>(null);
    const [token, setToken] = useState("");
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [accountId, setAccountId] = useState("");
    const [scriptName, setScriptName] = useState("");
    const [subdomain, setSubdomain] = useState("");
    const [contactEmail, setContactEmail] = useState("");
    const [busy, setBusy] = useState<"accounts" | "deploy" | "push" | null>(null);
    const [error, setError] = useState("");

    useEffect(() => setConfig(loadOfflineMessagesConfig()), []);
    const selectedAccount = useMemo(() => accounts.find((account) => account.id === accountId), [accounts, accountId]);

    const loadAccounts = async () => {
        setBusy("accounts");
        setError("");
        try {
            const payload = await readJson(await fetch("/api/offline-messages/cloudflare/accounts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token }),
            })) as { accounts: Account[] };
            setAccounts(payload.accounts || []);
            if (payload.accounts?.length === 1) setAccountId(payload.accounts[0].id);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    };

    const activatePush = async (target = config) => {
        if (!target) return;
        setBusy("push");
        setError("");
        try {
            await enableOfflineMessagePush(target);
            const next = { ...target, enabled: true };
            saveOfflineMessagesConfig(next);
            setConfig(next);
            startOfflineMessagesRuntime();
            onNotice("离线主动消息已启用");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    };

    const deploy = async () => {
        setBusy("deploy");
        setError("");
        try {
            const result = await readJson(await fetch("/api/offline-messages/cloudflare/deploy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token, accountId, scriptName, subdomain, contactEmail }),
            })) as DeployResult;
            const next: OfflineMessagesConfig = {
                enabled: false,
                workerUrl: result.workerUrl,
                serverToken: result.serverToken,
                userId: crypto.randomUUID(),
                accountId: result.accountId,
                scriptName: result.scriptName,
                databaseId: result.databaseId,
                deployedAt: Date.now(),
            };
            saveOfflineMessagesConfig(next);
            setConfig(next);
            setToken("");
            onNotice("Cloudflare 后端部署完成");
            if (typeof Notification !== "undefined" && Notification.permission === "granted") await activatePush(next);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    };

    const toggleEnabled = async () => {
        if (!config) return;
        if (!config.enabled) return activatePush(config);
        setBusy("push");
        setError("");
        try {
            await pauseOfflineMessages();
            setConfig(loadOfflineMessagesConfig());
            onNotice("已暂停云端主动消息；Cloudflare 资源仍保留");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="flex flex-col gap-4 px-4 pb-8 pt-3 text-[var(--c-text)]">
            <section className="rounded-[22px] border border-[var(--c-border)] bg-[var(--c-surface)] p-4 shadow-sm">
                <div className="flex items-start gap-3">
                    <div className="rounded-2xl bg-sky-500/12 p-3 text-sky-500"><Cloud size={24} /></div>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-[17px] font-semibold">Cloudflare 离线主动消息</h2>
                        <p className="mt-1 text-[13px] leading-5 text-[var(--c-muted)]">关掉网页或切换 App 后，角色仍能按原本的主动消息规则生成内容，并透过系统通知送到手机。</p>
                    </div>
                </div>
            </section>

            {config ? (
                <section className="rounded-[22px] border border-[var(--c-border)] bg-[var(--c-surface)] p-4">
                    <div className="flex items-center gap-2">
                        {config.enabled ? <CheckCircle2 size={19} className="text-emerald-500" /> : <TriangleAlert size={19} className="text-amber-500" />}
                        <span className="font-semibold">{config.enabled ? "已启用" : "后端已部署，等待开启推播"}</span>
                    </div>
                    <div className="mt-3 rounded-2xl bg-black/5 p-3 text-[12px] dark:bg-white/5">
                        <div className="font-medium">{config.scriptName}</div>
                        <div className="mt-1 break-all text-[var(--c-muted)]">{config.workerUrl}</div>
                    </div>
                    <button type="button" onClick={toggleEnabled} disabled={busy !== null} className={`mt-4 flex w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold text-white ${config.enabled ? "bg-slate-500" : "bg-sky-500"}`}>
                        {busy === "push" ? <Loader2 size={18} className="animate-spin" /> : <BellRing size={18} />}
                        {config.enabled ? "暂停云端主动消息" : "允许通知并启用"}
                    </button>
                    <p className="mt-3 text-[12px] leading-5 text-[var(--c-muted)]">iPhone 必须先用 Safari「加入主画面」，再从主画面的 Float 开启通知。暂停不会删除 Cloudflare Worker 或 D1。</p>
                </section>
            ) : (
                <>
                    <section className="rounded-[22px] border border-[var(--c-border)] bg-[var(--c-surface)] p-4">
                        <label className="text-sm font-semibold">1. Cloudflare API Token</label>
                        <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="贴上刚申请的 Token" autoComplete="off" className="mt-3 w-full rounded-2xl border border-[var(--c-border)] bg-transparent px-4 py-3 text-sm outline-none focus:border-sky-500" />
                        <div className="mt-3 flex items-start gap-2 text-[12px] leading-5 text-[var(--c-muted)]"><ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-500" />Token 只经由你自己的 Float 后端送到 Cloudflare，本页不会保存，也不会写进 GitHub。</div>
                        <button type="button" onClick={loadAccounts} disabled={busy !== null || token.trim().length < 20} className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-sky-500 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40">
                            {busy === "accounts" && <Loader2 size={18} className="animate-spin" />}读取 Cloudflare 帐号
                        </button>
                    </section>

                    {accounts.length > 0 && (
                        <section className="rounded-[22px] border border-[var(--c-border)] bg-[var(--c-surface)] p-4">
                            <label className="text-sm font-semibold">2. 部署位置</label>
                            <select value={accountId} onChange={(event) => setAccountId(event.target.value)} className="mt-3 w-full rounded-2xl border border-[var(--c-border)] bg-[var(--c-surface)] px-4 py-3 text-sm">
                                <option value="">选择帐号</option>
                                {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
                            </select>
                            <input value={scriptName} onChange={(event) => setScriptName(event.target.value)} placeholder="Worker 名称（留空自动产生）" className="mt-3 w-full rounded-2xl border border-[var(--c-border)] bg-transparent px-4 py-3 text-sm" />
                            <input value={subdomain} onChange={(event) => setSubdomain(event.target.value)} placeholder="新帐号才需要：workers.dev 子网域" className="mt-3 w-full rounded-2xl border border-[var(--c-border)] bg-transparent px-4 py-3 text-sm" />
                            <input type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} placeholder="VAPID 联络信箱（可留空）" className="mt-3 w-full rounded-2xl border border-[var(--c-border)] bg-transparent px-4 py-3 text-sm" />
                            <button type="button" onClick={deploy} disabled={busy !== null || !accountId} className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-sky-500 to-indigo-500 px-4 py-3 text-sm font-semibold text-white disabled:opacity-40">
                                {busy === "deploy" && <Loader2 size={18} className="animate-spin" />}部署到 {selectedAccount?.name || "Cloudflare"}
                            </button>
                            <p className="mt-3 text-[12px] leading-5 text-[var(--c-muted)]">会建立 1 个 Worker、1 个 D1 数据库与每分钟 1 次的 Cron Trigger。Cloudflare 免费方案即可使用。</p>
                        </section>
                    )}
                </>
            )}

            {error && <div className="whitespace-pre-wrap rounded-2xl border border-red-400/30 bg-red-500/10 p-3 text-[13px] leading-5 text-red-500">{error}</div>}
            {config && <button type="button" className="flex items-center justify-center gap-2 text-xs text-[var(--c-muted)]" onClick={() => navigator.clipboard.writeText(config.workerUrl).then(() => onNotice("Worker 网址已复制"))}><Copy size={14} />复制 Worker 网址</button>}
            {config && <button type="button" className="text-xs text-red-400" onClick={async () => {
                setBusy("push");
                setError("");
                try {
                    if (config.enabled) await pauseOfflineMessages();
                    clearOfflineMessagesConfig();
                    setConfig(null);
                    setAccounts([]);
                    setAccountId("");
                } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                } finally {
                    setBusy(null);
                }
            }}>忘记这套部署并重新设定（不会删除 Cloudflare 资源）</button>}
        </div>
    );
}
